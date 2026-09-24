# Eatwise: Data & Privacy

- The local profile feature stores a basic profile and confirmed meals in a local
  SQLite database on the user's own computer, only after explicit user consent.
  There is no cloud account and nothing is uploaded to our servers.
- Meal photos, raw chats, names, phone numbers, cities, medical records and
  medication details are never collected by this server.
- The local profile can be reused across new conversations on the same machine.
  Meals are kept for 180 days by default; the user can adjust retention or delete
  data at any time (`export_local_data` / `delete_local_data`).
- There is no cross-device sync and no automatic weekly report.
- The server makes no network calls and contains no payment flows.
