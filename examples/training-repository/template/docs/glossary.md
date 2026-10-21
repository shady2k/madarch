# Glossary

- **Order** - one purchase: its lines, prices and a status.
- **Outbox** - the table in which orders queues the messages it will publish.
- **Idempotency key** - a value the caller chooses so that repeating a request does not repeat its effect.
<!-- @@ since glossary-fix -->
- **CardToken** - a reference to a card in the card vault. The services never see the card number.
<!-- @@ end -->
<!-- @@ since glossary-fix -->
- **PaymentToken** - the proof a provider returns when it captured money.
<!-- @@ end -->
- **Capture** - the moment the money is taken from the card.
- **Zero-rated** - a product that is sold without sales tax.
