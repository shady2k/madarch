package application

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"training.example/orders/internal/domain"
)

// fakeStore is an in-memory OrderStore.
type fakeStore struct {
	orders    map[string]domain.Order
	customers map[string]bool
	created   int
}

func newFakeStore() *fakeStore {
	return &fakeStore{orders: map[string]domain.Order{}, customers: map[string]bool{"cus_1": true}}
}

func (f *fakeStore) Create(_ context.Context, o domain.Order) error {
	f.created++
	f.orders[o.ID] = o
	return nil
}

func (f *fakeStore) Save(_ context.Context, o domain.Order) error {
	if _, ok := f.orders[o.ID]; !ok {
		return domain.ErrNotFound
	}
	f.orders[o.ID] = o
	return nil
}

func (f *fakeStore) Get(_ context.Context, id string) (domain.Order, error) {
	o, ok := f.orders[id]
	if !ok {
		return domain.Order{}, domain.ErrNotFound
	}
	return o, nil
}

func (f *fakeStore) List(_ context.Context, filter ListFilter) ([]domain.Order, error) {
	var out []domain.Order
	for _, o := range f.orders {
		if filter.CustomerID == "" || o.CustomerID == filter.CustomerID {
			out = append(out, o)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *fakeStore) FindByRequestID(_ context.Context, customerID, requestID string) (domain.Order, error) {
	for _, o := range f.orders {
		if o.CustomerID == customerID && o.RequestID == requestID {
			return o, nil
		}
	}
	return domain.Order{}, domain.ErrNotFound
}

func (f *fakeStore) CustomerExists(_ context.Context, id string) (bool, error) {
	return f.customers[id], nil
}

func (f *fakeStore) ListCreatedBefore(_ context.Context, cutoff time.Time, limit int) ([]domain.Order, error) {
	var out []domain.Order
	for _, o := range f.orders {
		if o.CreatedAt.Before(cutoff) && o.Status != domain.Shipped && len(out) < limit {
			out = append(out, o)
		}
	}
	return out, nil
}

func (f *fakeStore) Delete(_ context.Context, ids []string) error {
	for _, id := range ids {
		delete(f.orders, id)
	}
	return nil
}

type noMetrics struct{}

func (noMetrics) OrderCreated()              {}
func (noMetrics) Transitioned(domain.Status) {}
func (noMetrics) Purged(int)                 {}

func newService(store *fakeStore, now time.Time) *Service {
	return NewService(store, noMetrics{}, func() time.Time { return now })
}

var day = time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)

func TestPlacePricesEveryLine(t *testing.T) {
	svc := newService(newFakeStore(), day)
	order, err := svc.Place(context.Background(), PlaceOrder{
		CustomerID:      "cus_1",
		DiscountPercent: 10,
		Items: []domain.Item{
			{SKU: "A-1", Quantity: 2, PriceCents: 1000},
			{SKU: "BOOK", Quantity: 1, PriceCents: 2000, ZeroRated: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Lines: 2000 and 2000. Discount 10% of each: 200 and 200. Tax 8% of 1800 = 144; the book pays none.
	if order.Subtotal != 4000 || order.Discount != 400 || order.Tax != 144 || order.Total != 3744 {
		t.Errorf("subtotal %d discount %d tax %d total %d, want 4000 400 144 3744", order.Subtotal, order.Discount, order.Tax, order.Total)
	}
	if order.Status != domain.PendingPayment {
		t.Errorf("status %s, want pending_payment", order.Status)
	}
}

func TestPlaceWithTheSameRequestIDReturnsTheFirstOrder(t *testing.T) {
	store := newFakeStore()
	svc := newService(store, day)
	cmd := PlaceOrder{CustomerID: "cus_1", RequestID: "req-1", Items: []domain.Item{{SKU: "A-1", Quantity: 1, PriceCents: 100}}}
	first, err := svc.Place(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Place(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || store.created != 1 {
		t.Errorf("second placement made order %s (created %d), want the first order %s", second.ID, store.created, first.ID)
	}
}

func TestPlaceRefusesWhatCannotBePriced(t *testing.T) {
	svc := newService(newFakeStore(), day)
	line := []domain.Item{{SKU: "A-1", Quantity: 1, PriceCents: 100}}
	cases := []struct {
		name string
		cmd  PlaceOrder
		want error
	}{
		{"unknown customer", PlaceOrder{CustomerID: "cus_9", Items: line}, ErrUnknownCustomer},
		{"discount above 100", PlaceOrder{CustomerID: "cus_1", Items: line, DiscountPercent: 101}, ErrInvalidDiscount},
		{"no lines", PlaceOrder{CustomerID: "cus_1"}, domain.ErrInvalidItems},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := svc.Place(context.Background(), c.cmd); !errors.Is(err, c.want) {
				t.Errorf("Place = %v, want %v", err, c.want)
			}
		})
	}
}

func TestPaymentEventsMoveTheOrder(t *testing.T) {
	store := newFakeStore()
	svc := newService(store, day)
	order, _ := svc.Place(context.Background(), PlaceOrder{CustomerID: "cus_1", Items: []domain.Item{{SKU: "A-1", Quantity: 1, PriceCents: 100}}})

	if err := svc.ApplyPaymentEvent(context.Background(), order.ID, "payment.failed", "card declined"); err != nil {
		t.Fatal(err)
	}
	got, _ := svc.Get(context.Background(), order.ID)
	if got.Status != domain.Cancelled || got.CancelReason != "card declined" {
		t.Errorf("order is %s (%q), want cancelled with the decline reason", got.Status, got.CancelReason)
	}
	if err := svc.ApplyPaymentEvent(context.Background(), order.ID, "payment.captured", ""); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Errorf("capturing a cancelled order = %v, want ErrInvalidTransition", err)
	}
	if err := svc.ApplyPaymentEvent(context.Background(), order.ID, "payment.unheard-of", ""); !errors.Is(err, ErrUnknownPaymentEvent) {
		t.Errorf("unknown kind = %v, want ErrUnknownPaymentEvent", err)
	}
}

func TestRetentionJobRemovesOnlyExpiredUnshippedOrders(t *testing.T) {
	store := newFakeStore()
	store.orders["old"] = domain.Order{ID: "old", Status: domain.Confirmed, CreatedAt: day.AddDate(0, 0, -91)}
	store.orders["old-shipped"] = domain.Order{ID: "old-shipped", Status: domain.Shipped, CreatedAt: day.AddDate(0, 0, -91)}
	store.orders["recent"] = domain.Order{ID: "recent", Status: domain.PendingPayment, CreatedAt: day.AddDate(0, 0, -2)}

	removed, err := newService(store, day).RunRetentionJob(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 || len(store.orders) != 2 {
		t.Errorf("removed %d, %d orders left; want 1 removed and 2 left", removed, len(store.orders))
	}
	if _, kept := store.orders["old-shipped"]; !kept {
		t.Error("the retention job removed a shipped order")
	}
}
