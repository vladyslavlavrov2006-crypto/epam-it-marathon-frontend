import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable, switchMap } from 'rxjs';
import { GuestInviteService } from '@app/services/reservation/guest-invite.service';
import { API_BASE_URL } from '@app/shared/config/api-base-url.token';
import { SKIP_ERROR_TOAST } from '@app/auth/skip-error-toast.context';
import { GroupSessionsResponse } from '@app/models/group-orders/group-sessions-response.model';
import { GroupStatusResponse } from '@app/models/group-orders/group-status.model';
import {
  SubmittedDish,
  SubmitGroupPreOrderRequest,
} from '@app/models/group-orders/submit-group-pre-order.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';

@Injectable({ providedIn: 'root' })
export class GroupOrdersService {
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly http = inject(HttpClient);
  private readonly guestInviteService = inject(GuestInviteService);

  getGroupInvite$(reservationId: string): Observable<GuestInvite> {
    return this.guestInviteService
      .getInviteToken$(reservationId)
      .pipe(switchMap(({ token }) => this.guestInviteService.getInvite$(token)));
  }

  getSessions$(
    groupReservationId: string,
    options?: { silent?: boolean }
  ): Observable<GroupSessionsResponse> {
    const url = `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/sessions`;
    if (options?.silent) {
      return this.http.get<GroupSessionsResponse>(url, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      });
    }

    return this.http.get<GroupSessionsResponse>(url);
  }

  getOwnerSessionId$(reservationId: string): Observable<string> {
    return this.http
      .get<{
        guestSessionId: string;
      }>(`${this.baseUrl}/reservations/${encodeURIComponent(reservationId)}/guest-session-id`)
      .pipe(map(({ guestSessionId }) => guestSessionId));
  }

  getStatus$(
    groupReservationId: string,
    options?: { silent?: boolean }
  ): Observable<GroupStatusResponse> {
    const url = `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/status`;
    if (options?.silent) {
      return this.http.get<GroupStatusResponse>(url, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      });
    }

    return this.http.get<GroupStatusResponse>(url);
  }

  submit$(groupReservationId: string, reservationId: string): Observable<SubmittedDish[]> {
    const body: SubmitGroupPreOrderRequest = { reservationId };
    return this.http.post<SubmittedDish[]>(
      `${this.baseUrl}/group-reservations/${encodeURIComponent(groupReservationId)}/submit`,
      body
    );
  }

  removeSession$(
    groupReservationId: string,
    guestSessionId: string
  ): Observable<GroupSessionsResponse> {
    return this.http.delete<GroupSessionsResponse>(
      `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/sessions/${encodeURIComponent(guestSessionId)}`
    );
  }
}
