package api
import prom "github.com/prometheus/client_golang/prometheus"
var requests = prom.NewCounter(prom.CounterOpts{Name:"requests_total"})
var latency = prom.NewHistogramVec(prom.HistogramOpts{Name:"latency", Namespace:"other", Subsystem:"sub"}, []string{"method"})
