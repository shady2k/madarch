# Build the orders binary, then copy it with the migrations into a small image.
# The build context is services/orders (docker-compose.yml, .github/workflows/ci.yml).
# @@ until pin-toolchain
FROM golang:1.22-alpine AS build
# @@ end
# @@ since pin-toolchain
FROM golang:1.22.5-alpine AS build
# @@ end
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/orders ./cmd/orders

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/orders /app/orders
COPY migrations /app/migrations
EXPOSE 8080
CMD ["/app/orders"]
