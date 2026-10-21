# Requirements

## Use cases

- **UC-1 Place order.** A signed-in shopper submits a cart. The order is
  stored in status `pending_payment` with its lines, discount, tax and total.
  Placing again with the same request id returns the first order.
- **UC-2 Pay.** Checkout asks payments to authorize the card for the order's
  total. A captured payment confirms the order; a declined one cancels it
  and the shopper is told why.
<!-- @@ since requirements-align -->
- **UC-3 Refund.** Support refunds a captured payment. A refund that brings
  the refunded total up to the captured amount moves the order to `refunded`.
- **UC-4 Apply promotion.** The shopper enters a code; the discount it gives
  is taken off the order before the payment is asked for.
<!-- @@ end -->

## Business rules

- **BR-1 Discount.** A discount is a percentage chosen by the caller of the
  orders service (checkout, after asking promotions). It is taken off each
  order line; orders applies the percentage it is given and does not choose one.
- **BR-2 Tax.** Sales tax is 8% of each line after its discount, rounded to
  the nearest cent. Zero-rated lines pay no tax.
- **BR-3 One charge per key.** Paying with an idempotency key that was
  already used returns the first payment; the card is never charged twice.
<!-- @@ since requirements-align -->
- **BR-4 Refunds.** Only a captured payment can be refunded, for a positive
  amount, within 30 days of the capture, and never for more than was
  captured in total.
- **BR-5 Promotion cap.** A promotion never takes off more than the subtotal.
<!-- @@ end -->
<!-- @@ since requirements-align -->

## Qualities

- The payment provider may be slow: a payment call that does not answer
  within the payment timeout is retried with growing waits and then declined.
- Every change of an order reaches Kafka exactly when the change is committed
  (see ADR-0002).
<!-- @@ end -->
