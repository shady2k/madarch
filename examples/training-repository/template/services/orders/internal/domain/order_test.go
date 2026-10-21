package domain

import (
	"errors"
	"testing"
	"time"
)

func TestTransition(t *testing.T) {
	cases := []struct {
		name  string
		from  Status
		event Event
		want  Status
		valid bool
	}{
		{"payment captured confirms a pending order", PendingPayment, PaymentCaptured, Confirmed, true},
		{"payment failed cancels a pending order", PendingPayment, PaymentFailed, Cancelled, true},
		{"a person can cancel a pending order", PendingPayment, CancelRequested, Cancelled, true},
		{"dispatch ships a confirmed order", Confirmed, ShipmentDispatched, Shipped, true},
		{"a person can cancel a confirmed order", Confirmed, CancelRequested, Cancelled, true},
		{"a refund closes a confirmed order", Confirmed, PaymentRefunded, Refunded, true},
		{"a refund closes a shipped order", Shipped, PaymentRefunded, Refunded, true},
		{"a pending order cannot ship", PendingPayment, ShipmentDispatched, PendingPayment, false},
		{"a cancelled order cannot be confirmed", Cancelled, PaymentCaptured, Cancelled, false},
		{"a shipped order cannot be cancelled", Shipped, CancelRequested, Shipped, false},
		{"a refunded order stays refunded", Refunded, PaymentCaptured, Refunded, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Transition(c.from, c.event)
			if c.valid && err != nil {
				t.Fatalf("Transition(%s, %s) failed: %v", c.from, c.event, err)
			}
			if !c.valid && !errors.Is(err, ErrInvalidTransition) {
				t.Fatalf("Transition(%s, %s) = %v, want ErrInvalidTransition", c.from, c.event, err)
			}
			if got != c.want {
				t.Errorf("Transition(%s, %s) = %s, want %s", c.from, c.event, got, c.want)
			}
		})
	}
}

func TestApplyStampsTheOrder(t *testing.T) {
	created := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	later := created.Add(time.Hour)
	order := NewOrder("ord_1", "cus_1", nil, created)
	if err := order.Apply(PaymentCaptured, later); err != nil {
		t.Fatal(err)
	}
	if order.Status != Confirmed || !order.UpdatedAt.Equal(later) {
		t.Errorf("order = %s updated %s, want confirmed updated %s", order.Status, order.UpdatedAt, later)
	}
	if err := order.Apply(PaymentFailed, later.Add(time.Hour)); err == nil {
		t.Error("a confirmed order accepted payment-failed")
	}
	if !order.UpdatedAt.Equal(later) {
		t.Error("a refused event changed the update time")
	}
}

func TestExpired(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		status  Status
		ageDays int
		want    bool
	}{
		{"a pending order on day 89 is kept", PendingPayment, 89, false},
		{"a pending order on day 90 expires", PendingPayment, 90, true},
		{"a confirmed order past 90 days expires", Confirmed, 120, true},
		{"a cancelled order past 90 days expires", Cancelled, 91, true},
		{"a shipped order never expires", Shipped, 400, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			order := Order{Status: c.status, CreatedAt: now.AddDate(0, 0, -c.ageDays)}
			if got := order.Expired(now); got != c.want {
				t.Errorf("Expired = %v, want %v", got, c.want)
			}
		})
	}
}

func TestPurgeExpiredSelectsOnlyExpiredOrders(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	orders := []Order{
		{ID: "old", Status: Confirmed, CreatedAt: now.AddDate(0, 0, -100)},
		{ID: "new", Status: PendingPayment, CreatedAt: now.AddDate(0, 0, -1)},
		{ID: "old-shipped", Status: Shipped, CreatedAt: now.AddDate(0, 0, -100)},
	}
	got := PurgeExpired(orders, now)
	if len(got) != 1 || got[0].ID != "old" {
		t.Errorf("PurgeExpired selected %v, want only the old unshipped order", got)
	}
}

func TestValidateItems(t *testing.T) {
	cases := []struct {
		name  string
		items []Item
		ok    bool
	}{
		{"one good line", []Item{{SKU: "A-1", Quantity: 2, PriceCents: 500}}, true},
		{"no lines", nil, false},
		{"a line without sku", []Item{{Quantity: 1, PriceCents: 500}}, false},
		{"a zero quantity", []Item{{SKU: "A-1", Quantity: 0, PriceCents: 500}}, false},
		{"a negative price", []Item{{SKU: "A-1", Quantity: 1, PriceCents: -1}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateItems(c.items)
			if c.ok && err != nil {
				t.Errorf("ValidateItems failed: %v", err)
			}
			if !c.ok && !errors.Is(err, ErrInvalidItems) {
				t.Errorf("ValidateItems = %v, want ErrInvalidItems", err)
			}
		})
	}
}
