import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { GroupStatusResponse } from '@app/models/group-orders/group-status.model';
import { Participant } from '@app/models/group-orders/participant.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  catchError,
  exhaustMap,
  finalize,
  forkJoin,
  interval,
  map,
  Observable,
  Subscription,
  switchMap,
  tap,
} from 'rxjs';

const SYNC_INTERVAL_MS = 15_000;

@Component({
  selector: 'app-group-order-page',
  imports: [CurrencyPipe, DatePipe, ParticipantCardComponent, ModalComponent],
  templateUrl: './group-order-page.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './group-order-page.component.scss',
})
export class GroupOrderPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly groupOrdersService = inject(GroupOrdersService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private syncSubscription: Subscription | null = null;

  readonly invite = signal<GuestInvite | null>(null);
  readonly participants = signal<Participant[]>([]);
  readonly ownerSessionId = signal('');
  readonly groupStatus = signal<GroupStatusResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly confirmSubmitOpen = signal(false);
  readonly lastUpdated = signal<Date | null>(null);
  readonly refreshError = signal(false);
  readonly refreshing = signal(false);
  readonly selectedGuest = signal<Participant | null>(null);
  readonly removingGuest = signal(false);

  readonly consolidatedOrder = computed(() => consolidatePreOrder(this.participants()));
  readonly unsubmittedCount = computed(
    () => this.participants().filter((participant) => !participant.isSubmitted).length
  );
  readonly hasAnyDishes = computed(() =>
    this.participants().some((participant) => participant.items.length > 0)
  );
  readonly canSubmit = computed(
    () =>
      this.groupStatus()?.status === 'Open' &&
      this.consolidatedOrder().items.length > 0 &&
      !this.submitting()
  );
  readonly statusLabel = computed(() => {
    switch (this.groupStatus()?.status) {
      case 'Open':
        return 'Collecting pre-orders';
      case 'Submitted':
        return 'Sent to Restaurant';
      case 'Closed':
        return 'Closed';
      default:
        return '';
    }
  });

  constructor() {
    this.loadGroupOrder();
  }

  loadGroupOrder(): void {
    this.stopSynchronization();
    const reservationId = this.route.snapshot.paramMap.get('reservationId') ?? '';
    if (!reservationId) {
      this.error.set('Group reservation not found');
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.invite.set(null);
    this.participants.set([]);
    this.ownerSessionId.set('');
    this.groupStatus.set(null);
    this.lastUpdated.set(null);
    this.refreshError.set(false);

    this.groupOrdersService
      .getGroupInvite$(reservationId)
      .pipe(
        switchMap((invite) =>
          forkJoin({
            sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId),
            ownerSessionId: this.groupOrdersService.getOwnerSessionId$(reservationId),
            status: this.groupOrdersService.getStatus$(invite.GroupReservationId),
          }).pipe(
            map(({ sessions, ownerSessionId, status }) => ({
              invite,
              sessions,
              ownerSessionId,
              status,
            }))
          )
        )
      )
      .subscribe({
        next: ({ invite, sessions, ownerSessionId, status }) => {
          this.invite.set(invite);
          this.participants.set(sessions.participants);
          this.ownerSessionId.set(ownerSessionId);
          this.groupStatus.set(status);
          this.loading.set(false);
          this.lastUpdated.set(new Date());
          if (status.status === 'Open') {
            this.startSynchronization();
          }
        },
        error: (requestError: unknown) => {
          this.error.set(
            requestError instanceof HttpErrorResponse && requestError.status === 404
              ? 'Group reservation not found'
              : 'Unable to load group reservation. Please try again.'
          );
          this.loading.set(false);
        },
      });
  }

  openSubmitConfirmation(): void {
    if (this.canSubmit()) {
      this.confirmSubmitOpen.set(true);
    }
  }

  closeSubmitConfirmation(): void {
    if (!this.submitting()) {
      this.confirmSubmitOpen.set(false);
    }
  }

  submitPreOrder(): void {
    if (!this.canSubmit()) {
      return;
    }

    const groupReservationId = this.invite()?.GroupReservationId;
    const reservationId = this.route.snapshot.paramMap.get('reservationId') ?? '';
    if (!groupReservationId || !reservationId) {
      this.error.set('Group reservation not found');
      return;
    }

    this.submitting.set(true);
    this.groupOrdersService.submit$(groupReservationId, reservationId).subscribe({
      next: () => {
        this.stopSynchronization();
        this.groupStatus.update((status) => (status ? { ...status, status: 'Submitted' } : status));
        this.confirmSubmitOpen.set(false);
        this.toast.success('Pre-order sent to the restaurant');
      },
      error: () => {
        // The token interceptor already displays submit errors to the user.
        this.submitting.set(false);
      },
      complete: () => this.submitting.set(false),
    });
  }

  refreshNow(): void {
    this.synchronize$().subscribe();
  }

  openRemoveConfirmation(participant: Participant): void {
    if (participant.type === 'Guest' && this.groupStatus()?.status === 'Open') {
      this.selectedGuest.set(participant);
    }
  }

  closeRemoveConfirmation(): void {
    if (!this.removingGuest()) {
      this.selectedGuest.set(null);
    }
  }

  confirmRemoveGuest(): void {
    const guest = this.selectedGuest();
    const groupReservationId = this.invite()?.GroupReservationId;
    if (
      !guest ||
      guest.type !== 'Guest' ||
      this.groupStatus()?.status !== 'Open' ||
      !groupReservationId ||
      this.removingGuest()
    ) {
      return;
    }

    this.stopSynchronization();
    this.removingGuest.set(true);
    this.groupOrdersService.removeSession$(groupReservationId, guest.id).subscribe({
      next: (sessions) => {
        this.participants.set(sessions.participants);
        this.groupStatus.update((status) =>
          status ? { ...status, currentParticipants: sessions.participants.length } : status
        );
        this.lastUpdated.set(new Date());
        this.refreshError.set(false);
        this.selectedGuest.set(null);
      },
      error: () => {
        this.removingGuest.set(false);
        this.startSynchronization();
      },
      complete: () => {
        this.removingGuest.set(false);
        this.startSynchronization();
      },
    });
  }

  private startSynchronization(): void {
    if (this.syncSubscription) {
      return;
    }

    this.syncSubscription = interval(SYNC_INTERVAL_MS)
      .pipe(
        exhaustMap(() => this.synchronize$()),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();
  }

  private stopSynchronization(): void {
    this.syncSubscription?.unsubscribe();
    this.syncSubscription = null;
  }

  private synchronize$(): Observable<void> {
    const invite = this.invite();
    if (!invite || this.groupStatus()?.status !== 'Open' || this.refreshing()) {
      return EMPTY;
    }

    this.refreshing.set(true);
    return forkJoin({
      sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId, { silent: true }),
      status: this.groupOrdersService.getStatus$(invite.GroupReservationId, { silent: true }),
    }).pipe(
      tap(({ sessions, status }) => {
        this.participants.set(sessions.participants);
        this.groupStatus.set(status);
        this.lastUpdated.set(new Date());
        this.refreshError.set(false);
        if (status.status !== 'Open') {
          this.stopSynchronization();
        }
      }),
      map(() => undefined),
      catchError(() => {
        this.refreshError.set(true);
        return EMPTY;
      }),
      finalize(() => this.refreshing.set(false))
    );
  }
}
