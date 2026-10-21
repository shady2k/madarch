import { createApp } from './app';
import { CheckoutService } from './checkout-service';
import { loadConfig } from './config';
import { logger } from './logging/logger';
import { OrdersClient } from './orders-client';
// @@ since grpc-client
import { PaymentsClient } from './payments-client';
// @@ end
// @@ since apply-promotion
import { PromotionsClient } from './promotions-client';
// @@ end

const PORT = 8083;

const config = loadConfig();
// @@ until grpc-client
const service = new CheckoutService(new OrdersClient(config.ordersUrl));
// @@ end
// @@ since grpc-client until apply-promotion
const service = new CheckoutService(new OrdersClient(config.ordersUrl), new PaymentsClient(config.paymentsAddr, config.paymentsDeadlineMs));
// @@ end
// @@ since apply-promotion
const service = new CheckoutService(
  new OrdersClient(config.ordersUrl),
  new PaymentsClient(config.paymentsAddr, config.paymentsDeadlineMs),
  new PromotionsClient(config.promotionsUrl),
);
// @@ end

createApp(service).listen(PORT, () => {
  logger.info({ port: PORT, orders: config.ordersUrl }, 'checkout listening');
});
