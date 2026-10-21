# Plan: loyalty

Dated 2026-05-04. State: to-be. Nothing described here exists in the code or is deployed.

A new service, **loyalty**, will keep a points balance per customer. Checkout
will call it after a paid order to add points: a new relation, **checkout ->
loyalty**, over HTTP. Orders and payments do not change.
