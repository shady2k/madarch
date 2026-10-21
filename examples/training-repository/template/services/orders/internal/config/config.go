// Package config reads the process environment once.
package config

import (
	"fmt"
	"os"
	"strings"
	"sync"
)

// Config is everything the orders service reads from the environment.
type Config struct {
	// DatabaseURL is the Postgres connection string (DATABASE_URL, required).
	DatabaseURL string
// @@ since relay
	// KafkaBrokers is the comma-separated broker list (KAFKA_BROKERS, required).
	KafkaBrokers string
// @@ end
// @@ since jwt
	// JWTSecret signs and verifies the HS256 tokens (JWT_SECRET, required).
	JWTSecret string
// @@ end
}

var (
	once     sync.Once
	instance Config
	loadErr  error
)

// Load reads the environment the first time it is called and returns the same
// Config on every later call: the configuration is a process-wide singleton.
func Load() (Config, error) {
	once.Do(func() {
		instance, loadErr = fromEnv(os.Getenv)
	})
	return instance, loadErr
}

func fromEnv(get func(string) string) (Config, error) {
	var missing []string
	require := func(name string) string {
		value := get(name)
		if value == "" {
			missing = append(missing, name)
		}
		return value
	}

	var cfg Config
	cfg.DatabaseURL = require("DATABASE_URL")
// @@ since relay
	cfg.KafkaBrokers = require("KAFKA_BROKERS")
// @@ end
// @@ since jwt
	cfg.JWTSecret = require("JWT_SECRET")
// @@ end
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required environment variables: %s", strings.Join(missing, ", "))
	}
	return cfg, nil
}
