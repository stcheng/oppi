# Onboarding and Pairing

All commands run from `server/`.

## First device

1. Start the server:

   ```bash
   cd server
   node dist/src/cli.js serve
   ```

   On first run, Oppi shows:
   - pairing QR code
   - invite link

2. Open Oppi on iPhone.

3. In onboarding, choose one:
   - **Scan QR Code**
   - **Paste Invite Link**

4. Confirm server trust.

5. Oppi opens **Workspaces**.

6. If the server has no workspaces, Oppi opens **Create Workspace**.

## Additional devices

1. Generate a new invite:

   ```bash
   cd server
   node dist/src/cli.js pair
   ```

2. On the new phone, scan the QR code or paste the invite link.

## Invite rules

- Invite is single-use.
- Invite expires after 5 minutes.
- Invite includes server identity and transport details.

## Troubleshooting

### Invite expired or already used

1. Generate a new invite:

   ```bash
   cd server
   node dist/src/cli.js pair
   ```

2. Retry pairing.

### Could not reach server

1. Confirm phone-to-server connectivity (LAN or Tailscale).

2. Regenerate invite with explicit host:

   ```bash
   cd server
   node dist/src/cli.js pair --host <hostname-or-ip>
   ```

3. Retry pairing.

### Secure connection failed

1. Generate a fresh invite from the same server.

2. Retry pairing.

3. Do not edit invite content manually.
