# Contributing

Thanks for your interest in contributing to Radiatus!

Check out the [good first issues](https://github.com/Silicon-Docket/radiatus/contribute), or open one describing what you'd like to change before sending a large PR.

## Getting set up

See the [Quick start](./README.md#quick-start) in the README &mdash; the same steps you'd use to deploy the template also get you a working local environment for development.

Before opening a PR:

```bash
npm run lint
npm run typecheck
npm test
```

## AI usage

If you use an AI tool (Copilot, Claude, ChatGPT, etc.) to help with a contribution, that's fine &mdash; but please disclose it in the PR description, and make sure you've actually read, understood, and tested the change yourself before submitting. You're responsible for everything in the PR, generated or not.

## Scope

Radiatus is meant to stay a small, readable starting point &mdash; not grow into a framework. Prefer changes that make the existing template clearer or more correct over ones that add new configuration surface or optional features.
