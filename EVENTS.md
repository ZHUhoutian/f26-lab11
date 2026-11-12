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

Since `redeliver` hands over the *same* message (same id), I expect no
duplicate refund: one refund in total, however many times it is redelivered.

- Ledger: one entry for the booking, before and after both redeliveries.
- Payment provider: one settlement, and the money returned stays at one
  refund amount.
- Bus log: I did not predict the delivery count.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

```
> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.** They agree only on the first state:
after the cancellation there is one ledger entry, one settlement, and $85.00
returned. After that my prediction was wrong. Each redelivery wrote another
ledger entry (`led-2`, `led-3`) and made another real settlement at the
provider (`stl-2`, `stl-3`), so an $85.00 refund paid out $255.00. No dead
letters appeared, because nothing failed: the handler did exactly what it
was written to do, three times. The bus log shows `msg-3 deliveries=3`. It
is the *same* message id each time, and that is exactly why my reasoning
failed. "Same message" is true, but the bus keeps no record of who has
already handled a message (its contract says a subscriber "has to arrange
that itself"), and `RefundLedger.handle` never checked. A same id only
prevents duplicates if the handler uses it.

### Your fix

**The diff.** Paste it.

```diff
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..f883762 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -19,12 +19,23 @@ export interface LedgerEntry {
  * payment provider for the same amount. The ledger is append only: entries are
  * numbered in the order they were written, and nothing edits or removes one
  * after the fact.
+ *
+ * The bus delivers at least once, so the same message id can arrive any number
+ * of times. The handler keys on the message id and remembers the two steps
+ * separately: whether the ledger entry for that message has been written, and
+ * whether the provider has settled it. A redelivery skips whatever is already
+ * done and finishes whatever is not, so a delivery that wrote the entry and then
+ * failed at the provider is completed by the next one, without a second entry.
  */
 export class RefundLedger implements Subscriber<RefundRequested> {
   readonly name = 'RefundLedger';
 
   private readonly entries: LedgerEntry[] = [];
   private readonly gateway: PaymentGateway;
+  /** Message ids whose ledger entry has been written. */
+  private readonly recorded = new Set<string>();
+  /** Message ids the payment provider has settled. */
+  private readonly settled = new Set<string>();
 
   constructor(gateway: PaymentGateway) {
     this.gateway = gateway;
@@ -32,15 +43,23 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   handle(message: Message<RefundRequested>): void {
     const event = message.payload;
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
-    this.gateway.refund(event.bookingId, event.amountCents);
+    if (!this.recorded.has(message.id)) {
+      this.entries.push({
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+      });
+      this.recorded.add(message.id);
+    }
+    if (!this.settled.has(message.id)) {
+      // Marked only after refund() returns: if the provider throws, the next
+      // delivery of this message tries the payment again.
+      this.gateway.refund(event.bookingId, event.amountCents);
+      this.settled.add(message.id);
+    }
   }
 
   /** Every ledger entry, oldest first. */
```

(I also added two regression tests to `tests/handlers.test.ts`, one for
replay and one for fail-then-redeliver, and uncommented the optional
fast-check property. 36/36 pass and typecheck is clean.)

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** The key is the **message id**, which the bus guarantees
is the same on every redelivery. The handler tracks two steps per id
separately ("ledger entry written", and "provider settled", which is marked
only after `refund()` returns), so a redelivery skips what is done and
finishes what is not. It does **not** protect against:
- A *second, different* message for the same refund (a duplicate publish
  gets a new id and would pay again).
- A provider that settles and then fails to answer. The handler never marks
  that id settled, so a retry pays twice. Closing that gap needs an
  idempotency key sent *to the provider*, which this gateway's API does not
  take.
- A restart: the seen-sets live in memory.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

```
> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same across its three states.** All three states are
identical:
- ledger entries = 1 (`led-1`, $85.00)
- gateway calls = 1
- gateway settlements = 1 (`stl-1`, $85.00)
- money returned = $85.00
- dead letters = 0

Ledger total = settled total = the refund owed. The only number that moves
is the bus's delivery count for `msg-3` (it ends at 3). The bus still
delivers three times, and the handler turns the second and third deliveries
into no-ops.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

```
> campus-reservations@1.0.0 demo:failure
> tsx src/demos/failureDemo.ts

armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

the refund message is in the log and in the dead-letter list. Milestone 3 asks what you do with it.
```

### Your recovery

**What, if anything, the failed delivery left undone.** The money. The
handler got halfway: it wrote `led-1` ($85.00) to the ledger, then
`gateway.refund` threw on call 1 before anything settled. The ledger now
says $85.00 was refunded while the provider has 0 settlements and $0.00
returned, and the two disagree by $85.00. Everything outside the refund
finished: `cancel()` returned with the booking `cancelled`, and the
`booking.cancelled` subscribers (mail, reminder, stats) ran normally. The
caller never saw the failure, because `publish` does not throw. The only
trace is the dead letter for `msg-3`, attempt 1, in `RefundLedger`. Nothing
retries on its own, so the organizer stays unpaid until someone acts.

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

**Option taken: redeliver.** At the end of `main()` in
`src/demos/failureDemo.ts` I added a guarded
`app.bus.redeliver(cancellation.refundMessageId)`, followed by
`printRefundState` and `printMessageLog`. `npm run typecheck` is still
green and 36/36 tests pass. The state after the redelivery:

```
redelivering msg-3

=== after redelivering the refund message ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}
```

The bus log line for the refund message:

```
  msg-3 refund.requested deliveries=2
```

Delivery 2 of `msg-3` finished what delivery 1 left undone:
- The ledger was **not** written again. It is still one entry, `led-1`,
  because the message id was already in the "recorded" set.
- The payment **was** made: gateway call 2 produced `stl-1`, $85.00, because
  the id was not in the "settled" set.
- Ledger total = settled total = $85.00, and no new dead letter appeared.

The old dead letter is still listed, because the list is a log, not a queue,
and `redeliver` removes nothing from it. "Resolved" therefore has to be read
from the provider and the delivery count, not from the dead-letter list.

This redelivery is safe only because of the milestone 2 fix:
- With the original handler it would have written `led-2`. The ledger would
  say $170.00 refunded while $85.00 was paid.
- With a single "seen this message id, skip" check it would have skipped the
  whole handler. The organizer would never be paid, and the ledger would
  still claim $85.00.

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.

Leaving it for triage would have cost the following:
- **Who does the work:** a person. They read the dead letter's `message.id`,
  `payload.bookingId` and `amountCents`, `subscriberName`, `reason`, and
  `attempt`, check the provider for a settlement on `bk-1001`, and only then
  redeliver or refund by hand.
- **When the organizer gets the $85.00:** whenever someone gets to the list,
  hours or a business day later instead of immediately.
- **What it buys in return:** it is safe even without an idempotent handler
  or a healed provider, because a human confirms nothing settled before any
  money moves. That is also the one case my fix cannot see: a provider that
  settled and then failed to answer.
