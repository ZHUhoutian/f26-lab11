import type { RefundRequested } from '../bus/events';
import type { Message, Subscriber } from '../bus/inMemoryBus';
import type { PaymentGateway } from '../integrations/paymentGateway';

/** One line in the refund ledger. */
export interface LedgerEntry {
  entryId: string;
  bookingId: string;
  organizer: string;
  amountCents: number;
  reason: string;
  recordedAtMinute: number;
}

/**
 * Books refunds and sends the money back.
 *
 * For a refund message the handler writes a ledger entry, then calls the
 * payment provider for the same amount. The ledger is append only: entries are
 * numbered in the order they were written, and nothing edits or removes one
 * after the fact.
 *
 * The bus delivers at least once, so the same message id can arrive any number
 * of times. The handler keys on the message id and remembers the two steps
 * separately: whether the ledger entry for that message has been written, and
 * whether the provider has settled it. A redelivery skips whatever is already
 * done and finishes whatever is not, so a delivery that wrote the entry and then
 * failed at the provider is completed by the next one, without a second entry.
 */
export class RefundLedger implements Subscriber<RefundRequested> {
  readonly name = 'RefundLedger';

  private readonly entries: LedgerEntry[] = [];
  private readonly gateway: PaymentGateway;
  /** Message ids whose ledger entry has been written. */
  private readonly recorded = new Set<string>();
  /** Message ids the payment provider has settled. */
  private readonly settled = new Set<string>();

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  handle(message: Message<RefundRequested>): void {
    const event = message.payload;
    if (!this.recorded.has(message.id)) {
      this.entries.push({
        entryId: `led-${this.entries.length + 1}`,
        bookingId: event.bookingId,
        organizer: event.organizer,
        amountCents: event.amountCents,
        reason: event.reason,
        recordedAtMinute: message.publishedAtMinute,
      });
      this.recorded.add(message.id);
    }
    if (!this.settled.has(message.id)) {
      // Marked only after refund() returns: if the provider throws, the next
      // delivery of this message tries the payment again.
      this.gateway.refund(event.bookingId, event.amountCents);
      this.settled.add(message.id);
    }
  }

  /** Every ledger entry, oldest first. */
  all(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Entries for one booking, oldest first. */
  forBooking(bookingId: string): LedgerEntry[] {
    return this.all().filter((entry) => entry.bookingId === bookingId);
  }

  /** What the ledger says has been refunded, in cents. */
  totalRefundedCents(): number {
    return this.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  }

  size(): number {
    return this.entries.length;
  }
}
