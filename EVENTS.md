# EVENTS.md

One section per milestone. Fill each one in order as you go.

The prediction in milestone 2 should be written before you run the replay. That is the
part a TA will ask about.

Keep it short and specific. Point at operations, call sites, and what a caller
gets back.

---

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

One row per operation. Read the code, not the file
names. "As wired today" is what the code does now. "Your call" is what you
would do if this were your service. List up to eight operations, and remove
the rows you don't use.

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Validate, conflict-check, and save the booking (`BookingService.book`, `store.save`) | Synchronous, in the request | Synchronous | The caller is asking "do I have the room?" and the answer is this write. |
| 2 | Index the booking for the room-finder (`searchIndex.indexBooking`, `bookingService.ts:94`) | Synchronous, in `book()`, before `store.save`, no try/catch | Event-driven: a subscriber on `booking.confirmed` | Nobody waits for the room-finder, and a search outage should not stop bookings. |
| 3 | Write the audit record (`audit.record` in `book`/`cancel`) | Synchronous, in the request | Synchronous | It records what the operation did, so it has to commit with it, and it is local and cannot fail on its own. |
| 4 | Send confirmation and cancellation mail (`EmailConfirmationHandler`) | Event, on `booking.confirmed` / `booking.cancelled` | Event | The organizer does not need the mail in the response, and a mail relay outage should not fail a booking. |
| 5 | Render the receipt (`ReceiptGenerator`) | Event, on `booking.confirmed` | Event | It is downloaded later, it is filed by booking id, and a second render replaces the first. |
| 6 | Schedule and drop the reminder (`ReminderScheduler`) | Event, on `booking.confirmed` / `booking.cancelled` | Event | It is needed 30 minutes before the start, hours away, and it is keyed by booking id. |
| 7 | Update dashboard stats (`StatsUpdater`) | Event, on confirmed/cancelled (recounts the store) | Event | An ops dashboard can lag a little, and a recount gives the same answer on every delivery. |
| 8 | Pay the refund: ledger entry and payment provider call (`RefundLedger`) | Event, on `refund.requested` (the amount is computed synchronously in `cancel`) | Event, with an idempotent handler | The provider is external and can fail, so the cancel should not wait on it, but money must move exactly once. |

### Two calls in detail

**Row 2: index the booking for the room-finder. My call: event-driven.**
The caller of `book()` is the reservations page or the front-desk kiosk, and
what it needs right away is "you have the room" or "you don't". Nothing in
that answer comes from the search cluster. The conflict check at
`bookingService.ts:71` reads `store.all()`, not the index, so the search
cluster has no say in whether a booking is valid. The only reader of the
index is the room-finder page, and it can show a new booking a few seconds,
or during maintenance half an hour, late. Wired synchronously, a search
outage turns into a booking outage: the caller gets a
`SearchIndexUnavailableError` and no booking. Wired as a `booking.confirmed`
subscriber, the booking is saved and confirmed, the bus records a dead
letter for the indexer, and the room-finder catches up when the row is
replayed after the cluster comes back. `indexBooking` replaces the row for a
booking id, so replaying it is harmless. The cost is that the room-finder is
eventually consistent and someone has to replay the dead letters (or a
reindex job has to run). That is the right trade, because the search team
takes the cluster down every month.

**Row 8: pay the refund. My call: keep it event-driven, and make the handler
idempotent.**
The caller of `cancel()` needs two things right away: the booking released,
and how much it will get back. Both are decided synchronously in `cancel()`
(`store.save` and `refundFor`), and both stay there. It does not need the
money to have reached the card before the page responds, because a refund
taking minutes or hours is normal. The payment provider is an external
system that can be slow or fail, and if `cancel()` called it inline, a
provider outage would block cancellations the same way search blocked
bookings. As an event, a provider failure leaves the cancellation done and
the refund message dead-lettered for a retry. The price of moving it off the
request path is that the bus is at-least-once, so the handler will
eventually see the same refund message twice and must not pay twice. That is
milestone 2.

### The incident

**The call behind `TICKET.md`.** `src/service/bookingService.ts`, method
`BookingService.book`, line 94:

```ts
this.searchIndex.indexBooking(booking, room, now);
```

When the cluster is down, `indexBooking` throws `SearchIndexUnavailableError`.
`book()` has no try/catch, so the exception goes straight to the caller (the
page or the kiosk). The caller gets an error instead of a `Booking`, and not
even a `BookingError`, just the raw search error. Line 94 runs before
`store.save` (line 95), the audit record, and the `booking.confirmed`
publish, so nothing is saved, audited, or announced. The booking number has
already been incremented (line 92), so each failed attempt burns an id.
`cancel()` never touches the search index, which is why cancellations kept
working. Bookings recovered "without anybody touching" the service because
nothing else was broken. Answer to the ticket's question: booking a room
needs nothing from the search cluster. Availability comes from the store.
The index only feeds the room-finder.

Reproduced with a scratch script (search turned off, then `book` and
`cancel`):

```
book threw: SearchIndexUnavailableError - search index is unavailable
store size: 1 audit: 1 bus msgs: 1
cancel during outage -> cancelled
next booking id: bk-1003
```

---

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What you expect `redeliver` on a refund message to do.** Name what you expect
to change in the ledger, at the payment provider, and in the bus log. Write it
down, then run the demo.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

**Your prediction against the run.** Where they agree and where they do not.

### Your fix

**The diff.** Paste it.

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

**What stays the same across its three states.** Name the numbers you
compared.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

### Your recovery

**What, if anything, the failed delivery left undone.**

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.
