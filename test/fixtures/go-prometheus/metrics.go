package api
import prom "github.com/prometheus/client_golang/prometheus"
var requests = prom.NewCounter(prom.CounterOpts{Name: "requests_total"})
func update() { requests.Inc() }
func unrelated(requests any) { requests.Inc() }
