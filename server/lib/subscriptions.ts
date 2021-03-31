import OrderStatus from '../constants/order_status';
import { Unauthorized } from '../graphql/errors';
import models, { sequelize } from '../models';
import {
  createPaypalPaymentMethodForSubscription,
  setupPaypalSubscriptionForOrder,
} from '../paymentProviders/paypal/subscription';

import { findPaymentMethodProvider } from './payments';

export const updateSubscriptionWithPaypal = async (
  user: typeof models.User,
  order: typeof models.Order,
  paypalSubscriptionId: string,
): Promise<typeof models.Order> => {
  const paymentMethod = await createPaypalPaymentMethodForSubscription(order, user, paypalSubscriptionId);
  await setupPaypalSubscriptionForOrder(order, paymentMethod);
  // TODO what if amount changes?
  // TODO restore original order if update fails
  return order.update({ PaymentMethodId: paymentMethod.id });
};

// Update the subscription
const getIsSubscriptionManagedExternally = pm => {
  const provider = findPaymentMethodProvider(pm);
  return Boolean(provider?.features.isRecurringManagedExternally);
};

export const updatePaymentMethodForSubscription = async (
  user: typeof models.User,
  order: typeof models.Order,
  newPaymentMethod: typeof models.PaymentMethod,
): Promise<typeof models.Order> => {
  const prevPaymentMethod = order.paymentMethod;
  const newPaymentMethodCollective = await newPaymentMethod.getCollective();
  if (!user.isAdminOfCollective(newPaymentMethodCollective)) {
    throw new Unauthorized("You don't have permission to use this payment method");
  }

  const newStatus = order.status === OrderStatus.ERROR ? OrderStatus.ACTIVE : order.status;
  const wasManagedExternally = getIsSubscriptionManagedExternally(prevPaymentMethod);
  const isManagedExternally = getIsSubscriptionManagedExternally(newPaymentMethod);

  return sequelize.transaction(async transaction => {
    order = await order.update({ PaymentMethodId: newPaymentMethod.id, status: newStatus }, { transaction });
    if (wasManagedExternally !== isManagedExternally) {
      await order.Subscription.update({ isManagedExternally, paypalSubscriptionId: null }, { transaction });
    }
    return order;
  });
};

const checkSubscriptionDetails = (order, tier, amountInCents) => {
  if (tier && tier.CollectiveId !== order.CollectiveId) {
    throw new Error(`This tier (#${tier.id}) doesn't belong to the given Collective #${order.CollectiveId}`);
  }

  // The amount can never be less than $1.00
  if (amountInCents < 100) {
    throw new Error('Invalid amount.');
  }

  // If using a named tier, amount can never be less than the minimum amount
  if (tier && tier.amountType === 'FLEXIBLE' && amountInCents < tier.minimumAmount) {
    throw new Error('Amount is less than minimum value allowed for this Tier.');
  }

  // If using a FIXED tier, amount cannot be different from the tier's amount
  // TODO: it should be amountInCents !== tier.amount, but we need to do work to make sure that would play well with platform fees/taxes
  if (tier && tier.amountType === 'FIXED' && amountInCents < tier.amount) {
    throw new Error('Amount is incorrect for this Tier.');
  }
};

export const updateSubscriptionDetails = async (
  user: typeof models.User,
  order: typeof models.Order,
  tier: typeof models.Tier,
  amountInCents: number,
): Promise<typeof models.Order> => {
  checkSubscriptionDetails(order, tier, amountInCents);

  // check if the amount is different from the previous amount - update subscription as well
  if (amountInCents !== order.totalAmount) {
    order = await order.update({ totalAmount: amountInCents });
    order.Subscription = await order.Subscription.update({ amount: amountInCents });
  }

  // Update interval
  let newInterval = order.interval;
  if (tier?.interval && tier.interval !== 'flexible') {
    newInterval = tier.interval;
  }

  if (newInterval !== order.interval) {
    order = await order.update({ interval: newInterval });
    order.Subscription = await order.Subscription.update({ interval: newInterval });
  }

  // Custom contribution is null, named tier will be tier.id
  const tierToUpdateWith = tier ? tier.id : null;
  return order.update({ TierId: tierToUpdateWith });
};
