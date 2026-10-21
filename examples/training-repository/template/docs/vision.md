# Vision

The training shop sells goods online. This repository is the ordering and
payments side of it: everything between "the shopper presses Pay" and "the
parcel leaves the warehouse".

## Users

- **Shopper** - fills a cart, applies a promotion code, pays by card and
  expects the order to be confirmed or cleanly cancelled, never half done.
- **Support agent** - looks up any order, cancels one on a customer's request,
  marks a confirmed order as shipped and starts refunds.
- **Finance** - reconciles what was captured and what was refunded each day,
  and pulls the list of orders for the month-end close.

## The value

A shopper who pays gets exactly one order and one charge, even when the
network repeats a request. Support can answer "where is my order and my
money" from one place. Finance gets numbers that add up to the cent.

## Journeys

1. **Place an order** - the shopper checks out; checkout prices the cart,
   places the order with the orders service and moves on to the payment.
2. **Pay** - checkout asks the payments service to authorize the card; the
   outcome confirms or cancels the order.
3. **Get a refund** - support refunds a captured payment, in part or in full,
   within thirty days of the capture.
4. **Use a promotion** - the shopper types a code; the promotions service says
   how much it takes off and checkout passes the percentage on to the order.
