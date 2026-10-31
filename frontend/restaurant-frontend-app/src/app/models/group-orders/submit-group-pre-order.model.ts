/** POST /group-reservations/{groupReservationId}/submit — request body */
export interface SubmitGroupPreOrderRequest {
  reservationId: string;
}

/** POST /group-reservations/{groupReservationId}/submit — response item */
export interface SubmittedDish {
  dishId: string;
  quantity: number;
}
