# ChatGPT Team Invite Portal (Deno Edition)

A Deno-based rewrite of the ChatGPT Team Invite management system. This application helps you manage ChatGPT Team seats, invite users via access keys, and automatically kick unauthorized or expired temporary users.

## Features

- **Team Management**: Add multiple ChatGPT Teams (via Session JSON), track seat usage, and manage tokens.
- **Access Keys**: Generate one-time access keys (Invite Codes) for users to join.
- **Auto Allocation**: Users are automatically assigned to available seats in your pool of Teams.
- **Temporary Access**: Support for "1-day Trial" keys. Users are invited and then automatically kicked after 24 hours.
- **Auto-Kick Service**: Background Cron job checks for:
  - Expired temporary users.
  - Unauthorized users (not in your invitation list).
- **Cloud Native**: Uses Deno KV for storage (no SQLite file management needed if deployed on Deno Deploy).

## Prerequisites

- [Deno](https://deno.com/) (v1.40 or higher recommended)

## Installation

1. Clone the repository.
2. Navigate to `deno-invite-portal`.

## Running Locally

```bash
deno task start
```

This will start the server on `http://localhost:8000`.

- **User Page**: `http://localhost:8000/`
- **Admin Panel**: `http://localhost:8000/admin`

*Note: The first time you run it, a local `kv.sqlite` file might be created if you are not using Deno Deploy.*

## Deployment (Deno Deploy)

1. Push this project to GitHub.
2. Create a new project on Deno Deploy.
3. Link the repository and set the entry point to `main.ts`.
4. Deno KV is managed automatically in the cloud.

## Admin Usage

1. Go to `/admin`.
2. **Add Team**:
   - Log in to your ChatGPT Team account.
   - Open Developer Tools (F12) -> Application -> Storage -> Cookies (or Local Storage).
   - Find the session data (typically you need the `accessToken` and account ID). 
   - *Tip*: The easiest way is to use the provided Python script (from original project) or just copy the full JSON if you have a helper tool.
   - Paste the JSON into the "Add Team" form.
3. **Generate Keys**: Create keys for your users.
4. **Distribute**: Send the URL and Key to your users.

## API Endpoints

- `GET /` - User Join Page
- `GET /admin` - Admin Dashboard
- `GET /api/admin/teams` - List teams
- `POST /api/admin/teams` - Add team
- `GET /api/admin/keys` - List keys
- `POST /api/admin/keys` - Generate keys
- `POST /api/join` - User join action

## Tech Stack

- **Runtime**: Deno
- **Framework**: Oak
- **Database**: Deno KV
- **Frontend**: Vanilla HTML/JS/CSS
