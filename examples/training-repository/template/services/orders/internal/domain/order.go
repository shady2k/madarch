// Package domain holds the Order aggregate and its status state machine.
package domain

import (
// @@ since read-orders
	"errors"
// @@ end
// @@ since errors
	"fmt"
// @@ end
	"time"
)

// @@ since expiry
// ExpiryDays is how many days an order that was never shipped may live.
const ExpiryDays = 90

// @@ end
// @@ since errors
// ErrInvalidTransition is returned when an event is not allowed in the order's status.
var ErrInvalidTransition = errors.New("event is not allowed in this status")

// @@ end
// @@ since read-orders
// ErrNotFound is returned by storage when no order has the requested id.
var ErrNotFound = errors.New("order not found")

// @@ end
// @@ since validate
// ErrInvalidItems is returned when the lines of an order cannot be priced.
var ErrInvalidItems = errors.New("order lines are not valid")

// @@ end
// Status is where an order is in its life.
type Status string

const (
	// PendingPayment: the order is placed and waits for the payment outcome.
	PendingPayment Status = "pending_payment"
	// Confirmed: the payment was captured.
	Confirmed Status = "confirmed"
	// Cancelled: the payment failed or someone cancelled the order.
	Cancelled Status = "cancelled"
// @@ since cancel-ship
	// Shipped: the parcel left the warehouse.
	Shipped Status = "shipped"
// @@ end
// @@ since refunded-status
	// Refunded: the payment was given back after confirmation.
	Refunded Status = "refunded"
// @@ end
)

// Event is something that happens to an order from outside.
type Event string

const (
	// PaymentCaptured: the payments service captured the money.
	PaymentCaptured Event = "payment-captured"
	// PaymentFailed: the payment was declined or timed out.
	PaymentFailed Event = "payment-failed"
// @@ since cancel-ship
	// CancelRequested: a person asked to cancel.
	CancelRequested Event = "cancel-requested"
	// ShipmentDispatched: the warehouse handed the parcel over.
	ShipmentDispatched Event = "shipment-dispatched"
// @@ end
// @@ since refunded-status
	// PaymentRefunded: the payments service gave the money back.
	PaymentRefunded Event = "payment-refunded"
// @@ end
)

// transitions is the whole state machine: from a status, an event leads to a status.
var transitions = map[Status]map[Event]Status{
	PendingPayment: {
		PaymentCaptured: Confirmed,
		PaymentFailed:   Cancelled,
// @@ since cancel-ship
		CancelRequested: Cancelled,
// @@ end
	},
// @@ since cancel-ship
	Confirmed: {
		ShipmentDispatched: Shipped,
		CancelRequested:    Cancelled,
// @@ end
// @@ since refunded-status
		PaymentRefunded:    Refunded,
// @@ end
// @@ since cancel-ship
	},
// @@ end
// @@ since refunded-status
	Shipped: {
		PaymentRefunded: Refunded,
	},
// @@ end
}

// Item is one line of an order.
type Item struct {
	SKU        string
	Quantity   int
	PriceCents int64
// @@ since tax-rounding
	ZeroRated  bool
// @@ end
}

// Order is the aggregate: everything about one purchase that has to stay consistent.
type Order struct {
	ID         string
	CustomerID string
	Status     Status
	Items      []Item

// @@ since place until preview
	// Total is in cents.
	Total int64
// @@ end
// @@ since preview
	// Money is in cents.
	Subtotal int64
	Discount int64
	Tax      int64
	Total    int64
// @@ end
// @@ since idempotent-place

	// RequestID is the client's idempotency key for placing the order.
	RequestID string
// @@ end
// @@ since decline-reason

	// CancelReason is why the order was cancelled, when someone said.
	CancelReason string
// @@ end

	CreatedAt time.Time
	UpdatedAt time.Time
}

// NewOrder starts an order in PendingPayment.
func NewOrder(id, customerID string, items []Item, now time.Time) Order {
	return Order{ID: id, CustomerID: customerID, Status: PendingPayment, Items: items, CreatedAt: now, UpdatedAt: now}
}

// @@ since aggregate until errors
// Transition returns the status that event leads to from the given status.
func Transition(from Status, event Event) (Status, bool) {
	next, ok := transitions[from][event]
	return next, ok
}

// Apply moves the order along the state machine; false means the event is not
// allowed in the current status and nothing changed.
func (o *Order) Apply(event Event, now time.Time) bool {
	next, ok := Transition(o.Status, event)
	if !ok {
		return false
	}
	o.Status = next
	o.UpdatedAt = now
	return true
}

// @@ end
// @@ since errors
// Transition returns the status that event leads to from the given status.
func Transition(from Status, event Event) (Status, error) {
	next, ok := transitions[from][event]
	if !ok {
		return from, fmt.Errorf("%w: %s while %s", ErrInvalidTransition, event, from)
	}
	return next, nil
}

// Apply moves the order along the state machine and stamps the change.
func (o *Order) Apply(event Event, now time.Time) error {
	next, err := Transition(o.Status, event)
	if err != nil {
		return err
	}
	o.Status = next
	o.UpdatedAt = now
	return nil
}

// @@ end
// @@ since validate
// ValidateItems checks that the lines can be priced: at least one, each with
// a SKU, a positive quantity and a price that is not negative.
func ValidateItems(items []Item) error {
	if len(items) == 0 {
		return fmt.Errorf("%w: an order needs at least one line", ErrInvalidItems)
	}
	for i, item := range items {
		if item.SKU == "" || item.Quantity <= 0 || item.PriceCents < 0 {
			return fmt.Errorf("%w: line %d (sku %q, quantity %d, price %d)", ErrInvalidItems, i+1, item.SKU, item.Quantity, item.PriceCents)
		}
	}
	return nil
}

// @@ end
// @@ since duplicate-events
// Outcome returns the status an event from the payments service leaves the
// order in, and false for an event that is not about a payment.
func Outcome(event Event) (Status, bool) {
	switch event {
	case PaymentCaptured:
		return Confirmed, true
	case PaymentFailed:
		return Cancelled, true
	case PaymentRefunded:
		return Refunded, true
	}
	return "", false
}

// @@ end
// @@ since expiry
// Expired reports whether the order is older than ExpiryDays and was never shipped.
func (o Order) Expired(now time.Time) bool {
	return o.Status != Shipped && now.Sub(o.CreatedAt) >= ExpiryDays*24*time.Hour
}

// PurgeExpired picks, from the given orders, the ones the retention job must
// remove at the given time. It only selects; the service deletes.
func PurgeExpired(orders []Order, now time.Time) []Order {
	var expired []Order
	for _, o := range orders {
		if o.Expired(now) {
			expired = append(expired, o)
		}
	}
	return expired
}
// @@ end
