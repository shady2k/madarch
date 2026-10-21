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
RUN CGO_ENABLED=0 go build -o /out/promotions ./cmd/promotions

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/promotions /app/promotions
COPY migrations /app/migrations
EXPOSE 8082
CMD ["/app/promotions"]
