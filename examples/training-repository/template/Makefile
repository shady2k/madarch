-include .env
export

.PHONY: run-orders test up down seed token

# @@ since place
# Run the orders service on the host; needs Postgres and Kafka from `make up`.
run-orders:
	cd services/orders && go run ./cmd/orders

# @@ end
test:
# @@ since place
	cd services/orders && go test ./...
# @@ end
# @@ since promotions-start
	cd services/promotions && go vet ./...
# @@ end
# @@ since factory
	cd services/payments && npm test
# @@ end
# @@ since preview
	cd services/checkout && npm test
# @@ end

up:
	docker compose up --build -d

down:
	docker compose down
# @@ since containers

# Creates the demo customer and the promotion codes (the services apply their own tables at start,
# the promotions table is created here).
seed:
	docker compose exec -T postgres psql -U training -d orders -f - < scripts/seed-orders.sql
	cat services/promotions/migrations/*.sql scripts/seed-promotions.sql | docker compose exec -T postgres psql -U training -d promotions -f -
# @@ end
# @@ since jwt

# Prints a token for the demo customer, signed with JWT_SECRET.
token:
	@node scripts/token.mjs
# @@ end
