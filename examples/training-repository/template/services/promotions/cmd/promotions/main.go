// Command promotions runs the promotions service.
package main

import (
	"context"
	"net/http"
	"os"
	"time"

	"training.example/promotions/internal/api"
	"training.example/promotions/internal/logging"
	"training.example/promotions/internal/store"
)

const listenAddr = ":8082"

func main() {
	log := logging.New("promotions")
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Error("DATABASE_URL is required")
		os.Exit(1)
	}
	promotions, err := store.Open(context.Background(), url)
	if err != nil {
		log.Error("cannot reach the promotions database", "error", err)
		os.Exit(1)
	}
	defer promotions.Close()

	handler := api.New(promotions, log, time.Now)
	server := &http.Server{Addr: listenAddr, Handler: handler.Routes(), ReadHeaderTimeout: 5 * time.Second}
	log.Info("promotions listening", "addr", listenAddr)
	if err := server.ListenAndServe(); err != nil {
		log.Error("promotions stopped", "error", err)
		os.Exit(1)
	}
}
