/** Only an allowlisted HTTP code selects local copy; never display server error text. */
export function conversationDeleteErrorKey(
  error: unknown,
  fallback:
    | 'com_ui_convo_delete_error'
    | 'com_ui_archive_delete_error' = 'com_ui_convo_delete_error',
): 'com_ui_convo_delete_pending' | typeof fallback {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return fallback;
  }
  const response = error.response;
  if (
    typeof response !== 'object' ||
    response === null ||
    !('status' in response) ||
    response.status !== 409 ||
    !('data' in response)
  ) {
    return fallback;
  }
  const data = response.data;
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    data.code === 'OPENSCHOOL_DELETION_PENDING'
    ? 'com_ui_convo_delete_pending'
    : fallback;
}
