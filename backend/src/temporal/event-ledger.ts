export function acceptSessionEvent(
  processedEventIds: string[],
  eventId: string,
  completionAlreadyReceived = false,
): boolean {
  if (completionAlreadyReceived || processedEventIds.includes(eventId)) return false;
  processedEventIds.push(eventId);
  return true;
}
