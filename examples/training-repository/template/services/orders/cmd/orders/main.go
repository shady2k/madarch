// Command orders runs the orders service: the HTTP API, the outbox relay, the
// payment-event consumer and the retention job, in one process.
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"training.example/orders/internal/api"
	"training.example/orders/internal/application"
	"training.example/orders/internal/config"
// @@ since consume-events
	"training.example/orders/internal/consumer"
// @@ end
	"training.example/orders/internal/logging"
// @@ since relay
	"training.example/orders/internal/relay"
// @@ end
	"training.example/orders/internal/store"
)

const (
	// listenAddr is the port the Dockerfile exposes and docker-compose.yml and
	// deploy/k8s/orders.yaml map.
	listenAddr = ":8080"
	// migrationsDir is where the Dockerfile copies the SQL files to.
	migrationsDir = "migrations"
)

func main() {
	if err := run(); err != nil {
		logging.New("orders").Error("orders stopped", "error", err)
		os.Exit(1)
	}
}

// run is the composition root: it reads the configuration, builds every
// collaborator once and hands each one its dependencies through its constructor.
// Nothing below this function reads the environment or creates its own
// database connection.
func run() error {
	log := logging.New("orders")
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := store.Migrate(ctx, db, migrationsDir); err != nil {
		return err
	}

// @@ since outbox-write
	outbox := store.NewOutboxWriter(store.OrdersTopic)
// @@ end
// @@ until outbox-write
	repository := store.NewOrderRepository(db)
// @@ end
// @@ since outbox-write
	repository := store.NewOrderRepository(db, outbox)
// @@ end
// @@ since metrics
	metrics := api.NewMetrics()
// @@ end
// @@ until metrics
	orders := application.NewService(repository, time.Now)
// @@ end
// @@ since metrics
	orders := application.NewService(repository, metrics, time.Now)
// @@ end
	handlers := api.NewOrderHandlers(orders)
// @@ until jwt
	router := api.NewRouter(api.Deps{Orders: handlers})
// @@ end
// @@ since jwt until metrics
	router := api.NewRouter(api.Deps{Orders: handlers, Log: log, JWTSecret: cfg.JWTSecret})
// @@ end
// @@ since metrics
	router := api.NewRouter(api.Deps{Orders: handlers, Log: log, JWTSecret: cfg.JWTSecret, Metrics: metrics})
// @@ end
	server := &http.Server{
		Addr:              listenAddr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	errs := make(chan error, 4)
	go func() {
		log.Info("orders listening", "addr", listenAddr)
		errs <- server.ListenAndServe()
	}()
// @@ since relay
	publisher := relay.NewKafkaPublisher(cfg.KafkaBrokers)
	defer publisher.Close()
	go func() { errs <- relay.New(db, publisher, log, time.Second).Run(ctx) }()
// @@ end
// @@ since consume-events
	go func() { errs <- consumer.NewPaymentEvents(cfg.KafkaBrokers, orders, log).Run(ctx) }()
// @@ end
// @@ since expiry
	go func() { errs <- runRetention(ctx, orders, log) }()
// @@ end

	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-errs:
		log.Error("a component stopped", "error", err)
	}
	stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}
