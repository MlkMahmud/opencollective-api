/* eslint-disable camelcase */

import { expect } from 'chai';
import sinon from 'sinon';

import * as PaypalAPI from '../../../../server/paymentProviders/paypal/api';
import { setupPaypalSubscriptionForOrder } from '../../../../server/paymentProviders/paypal/subscription';
import { randEmail } from '../../../stores';
import {
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakePaypalPlan,
  randStr,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const fakePaypalSubscriptionPm = (params = {}) => {
  return fakePaymentMethod({ service: 'paypal', type: 'subscription', token: randStr(), ...params });
};

describe('server/paymentProviders/paypal/subscription', () => {
  let sandbox, host, validSubscriptionParams;

  before(async () => {
    // Create host with PayPal
    await resetTestDB();
    host = await fakeHost();
    await fakeConnectedAccount({ service: 'paypal', clientId: randStr(), token: randStr(), CollectiveId: host.id });
    sandbox = sinon.createSandbox();
    const plan = await fakePaypalPlan({ product: { CollectiveId: host.id }, amount: 1000, interval: 'month' });
    validSubscriptionParams = {
      id: randStr(),
      status: 'APPROVED',
      plan_id: plan.id,
      subscriber: {
        email_address: randEmail(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('setupPaypalSubscriptionForOrder', () => {
    it('activates the subscription when params are valid', async () => {
      const paymentMethod = await fakePaypalSubscriptionPm();
      const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', TierId: null, totalAmount: 1000 });
      const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
      const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
      paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
      paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).returns(Promise.resolve());
      await setupPaypalSubscriptionForOrder(order, paymentMethod);
      sinon.assert.calledWith(paypalRequestStub, `${subscriptionUrl}/activate`);
      const createdSubscription = await order.getSubscription();
      expect(createdSubscription.paypalSubscriptionId).to.eq(validSubscriptionParams.id);
    });

    describe('subscription matches the contribution', () => {
      it('must be APPROVED', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm();
        const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', PaymentMethodId: paymentMethod.id });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns({ ...validSubscriptionParams, status: 'ACTIVE' });
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('Subscription must be approved to be activated');
      });

      it('must have an existing plan', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm();
        const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', TierId: null });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns({ ...validSubscriptionParams, plan_id: 'xxxxxxx' });
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('PayPal plan does not match the subscription (#XXXXXXXXX)');
      });

      it('must have a plan that match amount', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm();
        const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', TierId: null, totalAmount: 5000 });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('The plan amount does not match the order amount');
      });
    });

    describe('when a subscription already exists', () => {
      it('nothing happens if cancellation fails', async () => {});

      it('nothing happens if new subscription fails to be created', async () => {});

      it('existing subscription gets cancelled', async () => {});
    });
  });
});
