# Checkout

The backend for the frontend. `POST /checkout` applies the promotion code, places
the order at orders (HTTP), authorizes the payment at payments (gRPC) and cancels
the order again when the payment is declined. `POST /checkout/preview` prices a
cart without placing anything. Listens on 8083.
