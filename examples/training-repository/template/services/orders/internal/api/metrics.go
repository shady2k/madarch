package api

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"

	"training.example/orders/internal/domain"
)

// Metrics counts requests and order events and serves them in the Prometheus
// text format at /metrics. It implements application.Metrics.
type Metrics struct {
	requests atomic.Int64
	created  atomic.Int64
	purged   atomic.Int64

	mu          sync.Mutex
	transitions map[domain.Status]int64
}

// NewMetrics returns empty counters.
func NewMetrics() *Metrics {
	return &Metrics{transitions: map[domain.Status]int64{}}
}

// Count is a middleware that counts every request.
func (m *Metrics) Count(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.requests.Add(1)
		next.ServeHTTP(w, r)
	})
}

// OrderCreated counts one placed order.
func (m *Metrics) OrderCreated() { m.created.Add(1) }

// Transitioned counts one order that reached the status.
func (m *Metrics) Transitioned(to domain.Status) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.transitions[to]++
}

// Purged counts orders removed by the retention job.
func (m *Metrics) Purged(n int) { m.purged.Add(int64(n)) }

// ServeHTTP writes the counters.
func (m *Metrics) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "orders_http_requests_total %d\n", m.requests.Load())
	fmt.Fprintf(w, "orders_created_total %d\n", m.created.Load())
	fmt.Fprintf(w, "orders_purged_total %d\n", m.purged.Load())
	m.mu.Lock()
	defer m.mu.Unlock()
	statuses := make([]string, 0, len(m.transitions))
	for status := range m.transitions {
		statuses = append(statuses, string(status))
	}
	sort.Strings(statuses)
	for _, status := range statuses {
		fmt.Fprintf(w, "orders_transitions_total{status=%q} %d\n", status, m.transitions[domain.Status(status)])
	}
}
