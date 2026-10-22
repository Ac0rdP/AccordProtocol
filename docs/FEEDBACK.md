# Feedback Widget

The Accord Protocol includes an in-app feedback widget that allows users to report issues, suggest features, and share feedback directly from the application. Reports are filed as GitHub issues with relevant context to help maintainers triage and respond effectively.

## Features

- **Available across the app**: The feedback widget is accessible from the header/navigation area in all views
- **Rich context capture**: Automatically includes page/route, network, contract address, wallet address (if connected), app version, and browser information
- **GitHub issue integration**: Reports are filed as GitHub issues using pre-filled templates
- **Abuse protection**: Rate limiting prevents spam submissions (configurable limits)
- **User-friendly**: Simple modal interface with categories (Bug Report, Feature Request, General Feedback)

## Usage

1. Click the "Feedback" button in the app header
2. Select the feedback type (Bug Report, Feature Request, or Other)
3. Fill in the title and description
4. Review the automatically captured context (can be toggled/verified)
5. Submit to open a pre-filled GitHub issue

## Context Captured

The widget automatically captures:
- **Route/Page**: Current URL path and query parameters
- **Network**: Stellar network (Testnet/Mainnet/Futurenet) from environment config
- **Contract ID**: Deployed contract address if available
- **Wallet**: Connected wallet address (if authenticated)
- **App Version**: From package.json or build metadata
- **User Agent**: Browser and OS information
- **Timestamp**: When the feedback was submitted

## Rate Limiting & Abuse Protection

To prevent abuse:
- **Per-session limit**: Maximum submissions per browser session
- **Time-based throttling**: Cooldown period between submissions
- **Local storage tracking**: Submission history tracked in localStorage
- **Client-side validation**: Title and description length limits

## Filing Mechanism

### Option 1: GitHub Issue URL (Default)
The widget generates a pre-filled GitHub issue URL and opens it in a new tab. This works without requiring API tokens or backend infrastructure.

### Option 2: Direct API Submission (Optional)
For environments with GitHub API access configured, feedback can be submitted directly via the GitHub API.

## Configuration

Environment variables (frontend):
- `VITE_GITHUB_REPO`: Repository in `owner/repo` format (defaults to repo from git config or hardcoded)
- `VITE_FEEDBACK_ENABLED`: Enable/disable feedback widget (default: true)
- `VITE_FEEDBACK_RATE_LIMIT`: Max submissions per session (default: 5)

## Triage Process

When feedback is submitted as a GitHub issue:
1. Issues are labeled with `feedback` (and optionally `bug` or `enhancement` based on type)
2. Maintainers review new feedback issues regularly
3. Valid bugs are reproduced and prioritized
4. Feature requests are discussed and evaluated against roadmap
5. Duplicate issues are linked and closed with explanation
6. Users are notified of updates via GitHub notifications

## Development

### Adding the Widget
The widget is added to `App.tsx` and appears globally. Components:
- `frontend/src/components/FeedbackWidget.tsx` - Main widget component
- `frontend/src/lib/feedback.ts` - Utilities for context capture and submission

### Testing
```bash
cd frontend
npm run test -- FeedbackWidget
```

## Privacy

- No personal information is collected beyond what's explicitly provided
- Wallet addresses are only captured if the user is connected
- All data goes directly to GitHub issues (public by default on public repos)
- Rate limiting data is stored locally in the browser
