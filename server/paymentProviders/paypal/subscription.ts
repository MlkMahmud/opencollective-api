import config from 'config';
import { pick } from 'lodash';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import TierType from '../../constants/tiers';
import logger from '../../lib/logger';
import models from '../../models';
import PaypalPlan from '../../models/PaypalPlan';
import { PaymentProviderService } from '../types';

import { paypalRequest } from './api';

export const cancelPaypalSubscription = async (order, reason = undefined) => {
  const hostCollective = await order.collective.getHostCollective();
  const subscription = await order.getSubscription();
  await paypalRequest(`billing/subscriptions/${subscription.paypalSubscriptionId}/cancel`, { reason }, hostCollective);
};

export const createPaypalPaymentMethodForSubscription = (order, user, subscriptionId) => {
  return models.PaymentMethod.create({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    CreatedByUserId: user.id,
    CollectiveId: order.FromCollectiveId,
    currency: order.currency,
    saved: false,
    token: subscriptionId,
  });
};

type PaypalProductType = 'DIGITAL' | 'SERVICE';
type PaypalProductCategory = 'MERCHANDISE' | 'MEMBERSHIP_CLUBS_AND_ORGANIZATIONS' | 'NONPROFIT';

/**
 * See https://developer.paypal.com/docs/api/catalog-products/v1/#products-create-response
 */
export const getProductTypeAndCategory = (tier: typeof models.Tier): [PaypalProductType, PaypalProductCategory?] => {
  switch (tier?.type) {
    case TierType.TICKET:
      return ['DIGITAL'];
    case TierType.PRODUCT:
      return ['DIGITAL', 'MERCHANDISE'];
    case TierType.SERVICE:
      return ['SERVICE'];
    case TierType.MEMBERSHIP:
      return ['DIGITAL', 'MEMBERSHIP_CLUBS_AND_ORGANIZATIONS'];
    default:
      return ['DIGITAL', 'NONPROFIT'];
  }
};

/**
 * PayPal crashes if imageUrl is from http://localhost, which can happen when developing with
 * a local images service.
 */
const getImageUrlForPaypal = collective => {
  if (config.host.images.startsWith('http://localhost')) {
    return 'https://images.opencollective.com/opencollective/logo/256.png';
  } else {
    return collective.getImageUrl();
  }
};

async function createPaypalProduct(host, collective, tier) {
  const [type, category] = getProductTypeAndCategory(tier);

  return paypalRequest(
    `catalogs/products`,
    {
      /* eslint-disable camelcase */
      name: `Financial contribution to ${collective.name}`,
      description: `Financial contribution to ${collective.name}`,
      type,
      category,
      image_url: getImageUrlForPaypal(collective),
      home_url: `https://opencollective.com/${collective.slug}`,
      /* eslint-enable camelcase */
    },
    host,
  );
}

async function createPaypalPlan(host, collective, productId, interval, amount, currency, tier) {
  const description = models.Order.generateDescription(collective, amount, interval, tier);
  return paypalRequest(
    `billing/plans`,
    {
      /* eslint-disable camelcase */
      product_id: productId,
      name: description,
      description: description,
      billing_cycles: [
        {
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0, // This tells PayPal this recurring payment never ends (INFINITE)
          frequency: {
            interval_count: 1,
            interval_unit: interval.toUpperCase(), // month -> MONTH
          },
          pricing_scheme: {
            fixed_price: {
              value: (amount / 100).toString(), // 1667 -> '16.67'
              currency_code: currency,
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 4, // Will fail up to 4 times, after that the subscription gets cancelled
      },
      /* eslint-enable camelcase */
    },
    host,
  );
}

export async function getOrCreatePlan(host, collective, interval, amount, currency, tier = null): Promise<PaypalPlan> {
  const product = await models.PaypalProduct.findOne({
    where: { CollectiveId: collective.id, TierId: tier?.id || null },
    include: [
      {
        association: 'plans',
        required: false,
        where: { currency, interval, amount },
      },
    ],
  });

  if (product) {
    const plans = product['plans'];
    if (plans[0]) {
      // If we found a product and a plan matching these parameters, we can directly return them
      logger.debug(`PayPal: Returning existing plan ${plans[0].id}`);
      return plans[0];
    } else {
      // Otherwise we can create a new plan based on this product
      logger.debug(`PayPal: Re-using existing product ${product.id} and creating new plan`);
      const paypalPlan = await createPaypalPlan(host, collective, product.id, interval, amount, currency, tier);
      return models.PaypalPlan.create({
        id: <string>paypalPlan.id,
        ProductId: product.id,
        amount,
        currency,
        interval,
      });
    }
  } else {
    // If neither the plan or the product exist, we create both in one go
    logger.debug(`PayPal: Creating a new plan`);
    const paypalProduct = await createPaypalProduct(host, collective, tier);
    const paypalPlan = await createPaypalPlan(host, collective, paypalProduct.id, interval, amount, currency, tier);
    return models.PaypalPlan.create(
      {
        id: <string>paypalPlan.id,
        amount,
        currency,
        interval,
        product: {
          id: <string>paypalProduct.id,
          CollectiveId: collective.id,
          TierId: tier?.id,
        },
      },
      {
        // Passing include for Sequelize to understand what `product` is
        include: [{ association: 'product' }],
      },
    );
  }
}

export const setupPaypalSubscriptionForOrder = async (order, paymentMethod) => {
  const hostCollective = await order.collective.getHostCollective();
  const existingSubscription = order.SubscriptionId && (await order.getSubscription());
  const paypalSubscriptionId = paymentMethod.token;
  const initialSubscriptionParams = pick(existingSubscription?.dataValues, [
    'isManagedExternally',
    'stripeSubscriptionId',
    'paypalSubscriptionId',
  ]);

  // TODO handle case where a payment arrives on a cancelled subscription
  // TODO refactor payment method to PayPal<>Subscription
  try {
    const newPaypalSubscription = await fetchPaypalSubscription(hostCollective, paypalSubscriptionId);
    await verifySubscription(order, newPaypalSubscription);
    await paymentMethod.update({ name: newPaypalSubscription.subscriber['email_address'] });

    if (existingSubscription) {
      // Cancel existing PayPal subscription
      if (existingSubscription.paypalSubscriptionId) {
        await cancelPaypalSubscription(order, 'Changed payment method');
      }

      // Update the subscription with the new params
      await existingSubscription.update({
        isManagedExternally: true,
        stripeSubscriptionId: null,
        paypalSubscriptionId,
      });
    } else {
      await createSubscription(order, paypalSubscriptionId);
    }

    await paypalRequest(`billing/subscriptions/${paypalSubscriptionId}/activate`, null, hostCollective, 'POST');
  } catch (e) {
    logger.error(`[PayPal] Error while creating subscription: ${e}`);

    // Restore the initial subscription
    if (existingSubscription) {
      await existingSubscription.update(initialSubscriptionParams);
    }

    const error = new Error('Failed to activate PayPal subscription');
    error['rootException'] = e;
    throw error;
  }

  return order;
};

const createSubscription = async (order, paypalSubscriptionId) => {
  return order.createSubscription({
    paypalSubscriptionId,
    amount: order.totalAmount,
    currency: order.currency,
    interval: order.interval,
    quantity: order.quantity,
    isActive: false,
    isManagedExternally: true,
    nextChargeDate: new Date(), // It's supposed to be charged now
    nextPeriodStart: new Date(),
    chargeNumber: 0,
  });
};

const fetchPaypalSubscription = async (hostCollective, subscriptionId) => {
  return paypalRequest(`billing/subscriptions/${subscriptionId}`, null, hostCollective, 'GET');
};

/**
 * Ensures that subscription can be used for this contribution. This is to prevent malicious users
 * from manually creating a subscription that would not match the minimum imposed by a tier.
 */
const verifySubscription = async (order, paypalSubscription) => {
  if (paypalSubscription.status !== 'APPROVED') {
    throw new Error('Subscription must be approved to be activated');
  }

  const plan = await models.PaypalPlan.findOne({
    where: { id: paypalSubscription.plan_id },
    include: [
      {
        association: 'product',
        where: { CollectiveId: order.CollectiveId, TierId: order.TierId },
        required: true,
      },
    ],
  });

  if (!plan) {
    throw new Error(`PayPal plan does not match the subscription (#${paypalSubscription.id})`);
  } else if (plan.amount !== order.totalAmount) {
    throw new Error('The plan amount does not match the order amount');
  }

  // TODO: Would be great to check interval too
};

export const isPaypalSubscriptionPaymentMethod = (paymentMethod: typeof models.PaymentMethod): boolean => {
  return (
    paymentMethod?.service === PAYMENT_METHOD_SERVICE.PAYPAL && paymentMethod.type === PAYMENT_METHOD_TYPE.SUBSCRIPTION
  );
};

const PayPalSubscription: PaymentProviderService = {
  features: {
    recurring: true,
    isRecurringManagedExternally: true,
  },

  async processOrder(order: typeof models.Order): Promise<typeof models.Transaction> {
    return setupPaypalSubscriptionForOrder(order, order.paymentMethod);
  },
};

export default PayPalSubscription;
