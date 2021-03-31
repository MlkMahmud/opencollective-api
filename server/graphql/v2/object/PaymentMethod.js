import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { get, pick } from 'lodash';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE, PAYMENT_METHOD_TYPES } from '../../../constants/paymentMethods';
import { getLegacyPaymentMethodType, PaymentMethodLegacyType } from '../enum/PaymentMethodLegacyType';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { PaymentMethodType } from '../enum/PaymentMethodType';
import { idEncode } from '../identifiers';
import { Account } from '../interface/Account';
import { Amount } from '../object/Amount';
import { Host } from '../object/Host';
import ISODateTime from '../scalar/ISODateTime';

export const PaymentMethod = new GraphQLObjectType({
  name: 'PaymentMethod',
  description: 'PaymentMethod model',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return idEncode(paymentMethod.id, 'paymentMethod');
        },
      },
      legacyId: {
        type: GraphQLInt,
        resolve(paymentMethod) {
          return paymentMethod.id;
        },
      },
      name: {
        type: GraphQLString,
        resolve(paymentMethod, _, req) {
          if (
            paymentMethod.service === PAYMENT_METHOD_SERVICE.PAYPAL &&
            paymentMethod.type === PAYMENT_METHOD_TYPES.ADAPTIVE
          ) {
            return req.remoteUser?.isAdmin(paymentMethod.CollectiveId) ? paymentMethod.name : null;
          } else {
            return paymentMethod.name;
          }
        },
      },
      service: {
        type: PaymentMethodService,
      },
      type: {
        type: PaymentMethodType,
      },
      providerType: {
        description: 'Defines the type of the payment method. Meant to be moved to "type" in the future.',
        deprecationReason: '2021-03-02: Please use service + type',
        type: PaymentMethodLegacyType,
        resolve: getLegacyPaymentMethodType,
      },
      balance: {
        type: new GraphQLNonNull(Amount),
        description: 'Returns the balance amount and the currency of this paymentMethod',
        async resolve(paymentMethod, args, req) {
          const balance = await paymentMethod.getBalanceForUser(req.remoteUser);
          return { value: balance.amount, currency: paymentMethod.currency };
        },
      },
      account: {
        type: Account,
        resolve(paymentMethod, _, req) {
          if (paymentMethod.CollectiveId) {
            return req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
          }
        },
      },
      sourcePaymentMethod: {
        type: PaymentMethod,
        description: 'For gift cards, this field will return to the source payment method',
        resolve(paymentMethod, _, req) {
          if (paymentMethod.SourcePaymentMethodId && req.remoteUser?.isAdmin(paymentMethod.CollectiveId)) {
            return req.loaders.PaymentMethod.byId.load(paymentMethod.SourcePaymentMethodId);
          }
        },
      },
      data: {
        type: GraphQLJSON,
        resolve(paymentMethod, _, req) {
          if (!req.remoteUser?.isAdmin(paymentMethod.CollectiveId)) {
            return null;
          }

          // Protect and limit fields
          let allowedFields = [];
          if (paymentMethod.type === PAYMENT_METHOD_TYPE.GIFT_CARD) {
            allowedFields = ['email'];
          } else if (paymentMethod.type === PAYMENT_METHOD_TYPE.CREDITCARD) {
            allowedFields = ['fullName', 'expMonth', 'expYear', 'brand', 'country', 'last4'];
          }

          return pick(paymentMethod.data, allowedFields);
        },
      },
      limitedToHosts: {
        type: new GraphQLList(Host),
        async resolve(paymentMethod, args, req) {
          let hosts;
          if (paymentMethod.type === 'prepaid') {
            const hostId = get(paymentMethod, 'data.HostCollectiveId', null);
            if (!hostId) {
              return;
            }
            const host = await req.loaders.Collective.byId.load(hostId);
            hosts = [host];
          } else if (paymentMethod.type === PAYMENT_METHOD_TYPE.GIFT_CARD && paymentMethod.limitedToHostCollectiveIds) {
            hosts = paymentMethod.limitedToHostCollectiveIds.map(id => {
              return req.loaders.Collective.byId.load(id);
            });
          }
          return hosts;
        },
      },
      expiryDate: {
        type: ISODateTime,
      },
      createdAt: {
        type: ISODateTime,
      },
    };
  },
});
