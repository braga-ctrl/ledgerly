---
name: onboard-client
description: Onboard a new business client in Ledgerly and track their documents until they are approved. Use when the user mentions a new customer or client, onboarding, KYC or compliance paperwork, or asks why a client cannot place an order or be invoiced.
---

Ledgerly will not let anyone create an order or invoice for a client until every onboarding document is approved. Use the Ledgerly connector to run that process.

## Adding a client

1. Call `list_clients` first so you do not create a duplicate. Names are matched ignoring case.
2. Call `create_client` with the business name and, if the user has it, the contact email. The client starts with three required documents: `business_registration`, `tax_id` and `authorized_signatory`.
3. Tell the user which documents are outstanding.

## Moving documents forward

Call `update_client_document` with the client (name or id), the `doc_type`, and the new `status`:

- `received`: the client has sent the document. Use this when the user says it arrived.
- `approved`: the user has checked the document and accepts it.
- `rejected`: the document goes back to the client. Always pass a short `note` saying what is wrong, such as "scan is unreadable".
- `requested` with a new `doc_type` asks for an extra document, for example `proof_of_address`.

You cannot see the documents yourself. Only set a document to `approved` when the user has said they reviewed it and it is acceptable. If they only say it arrived, set `received`.

The client's status updates by itself: `documents_pending` until everything is in, `under_review` once every document is received or approved, and `approved` when all are approved. A rejection sends the client back to `documents_pending`.

## When someone asks why an order or invoice failed

Call `get_client` and read the document list. Name the exact documents that are still outstanding rather than saying onboarding is incomplete.

## Wrap up

Finish with the client's current status and the next action, for example "Acme is under review: tax ID still needs approval."
