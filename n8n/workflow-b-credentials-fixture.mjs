// Nonfunctional references for offline builds; never inherit real credentials.
export const credentialEnv = Object.freeze({
  N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID: 'synthetic-google-id',
  N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME: 'Synthetic Google Credential',
  N8N_TELEGRAM_CREDENTIAL_ID: 'synthetic-telegram-id',
  N8N_TELEGRAM_CREDENTIAL_NAME: 'Synthetic Telegram Credential',
});
