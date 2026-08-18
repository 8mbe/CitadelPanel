/**
 * Starting points for the operator-authored legal documents.
 *
 * The panel ships **no** default terms or privacy policy — see the note in
 * `services/settings.ts`. What it can honestly provide is a factual inventory:
 * this file enumerates the data CitadelPanel's own code stores, where it stores
 * it, and how long it keeps it, so an operator writing a privacy policy is not
 * reverse-engineering the schema to find out what they are disclosing.
 *
 * Everything here is a *draft*. It describes the software, not the operator —
 * it cannot know about the host's backups, log shipping, upstream provider, or
 * jurisdiction, and it says so in the placeholders. The admin editor inserts it
 * into an empty document and the admin edits from there.
 *
 * Keep this in sync with the schema. If a migration adds a table that holds
 * personal data, the inventory below is where users are told about it.
 */

/** Placeholder the operator is expected to replace before publishing. */
const TODO = "**[TODO: fill this in]**";

/**
 * A privacy-policy draft describing what this codebase actually stores.
 *
 * Written in the second person about the operator ("we") because that is the
 * voice a published policy needs; the operator inherits the text as their own.
 */
export function privacyPolicyTemplate(siteName: string): string {
  return `# Privacy Policy

_Last updated: ${TODO}_

This policy explains what data ${siteName} collects, why, and how long it is
kept. ${siteName} is a self-hosted game server control panel operated by
${TODO} (the "operator"). Questions about this policy go to ${TODO}.

> **Operator: read this before publishing.** The sections below were generated
> from what the panel software itself stores. They are accurate about the
> application, but they cannot describe *your* deployment: your hosting
> provider, backups, server logs, reverse proxy, and legal jurisdiction are
> yours to disclose. Replace every ${TODO} marker, delete anything that does not
> apply to you, and have the result reviewed if you operate commercially or
> serve users in a jurisdiction with statutory privacy duties.

## Who controls your data

The operator runs this panel on infrastructure they control. There is no
vendor, no shared cloud service, and no telemetry sent to the authors of the
software. Data leaves this installation only in the ways listed under
[Third parties](#third-parties) below.

## What we store about your account

When you create an account we store:

- **Your name and email address**, as you entered them.
- **A hash of your password.** The plaintext password is never stored and
  cannot be recovered — only reset.
- **Whether your email address has been verified.**
- **Your role** (regular user or administrator).
- **Two-factor authentication secrets and backup codes**, if you enable 2FA.
  These are stored encrypted.
- **Ban status**, including the reason and expiry, if an administrator bans
  your account.

## Sessions and API keys

- **Session records** are created when you sign in and expire after 7 days.
- **API keys**, if you create any, are stored as hashes alongside a short
  non-secret prefix used to identify them in the interface. The key itself is
  shown once at creation and never again.
- **SFTP credentials** are issued per user and per server so file transfers can
  be attributed to an individual rather than to a shared account.

## Activity and security logging

The panel keeps an audit log of privileged actions — starting and stopping
servers, editing files, changing settings, administrative actions, and similar.
Each entry records:

- **Which account performed the action**, and whether it acted through an API
  key.
- **The action and its target** (for example, which server).
- **Your IP address** at the time of the action.
- **The time of the action.**
- **Limited context**, such as the console command that was run or the setting
  that was changed. Secrets are never written to the audit log.

Console commands you type into a server console are recorded in the same way.
The panel also runs an automated check for suspicious resource usage and stores
the resulting flags for administrators to review.

Audit records exist so the operator can investigate abuse and so account owners
can see what happened on their servers. They are retained for ${TODO} and are
visible to administrators of this panel.

## Data about your game servers

For each server you own or have been granted access to, the panel stores its
configuration (name, resource limits, which node it runs on, published ports,
environment variables, linked servers, and provisioned databases) and the files
in its data directory. Values marked as secret — database passwords, secret
environment variables, node access tokens — are encrypted at rest.

Files you upload to a server are stored on the node that runs it. The operator
can technically access them; treat anything you upload as visible to the
operator.

## Cookies

The panel sets a session cookie when you sign in. It is required for the panel
to work and cannot be turned off while you are signed in. It is not used for
advertising or cross-site tracking.

${TODO}: if you have enabled web analytics in the panel settings, say so here
and name the provider. Plausible sets no cookies and collects no personal data;
Google Analytics does set cookies and does share data with Google, and in most
jurisdictions requires consent before it loads.

## Third parties

Depending on how the operator has configured this installation, data may reach:

- **An email provider** (SMTP server or Resend), which receives your email
  address in order to deliver verification, password-reset, and notification
  messages.
- **A captcha provider** (Cloudflare Turnstile, Google reCAPTCHA, or a
  self-hosted Cap instance), which receives your IP address and browser
  information when you sign in or register.
- **An AI provider**, if the console assistant is enabled. When you ask the
  assistant a question, the panel sends your question together with recent
  console output from the server in question to the configured provider.
- **A web analytics provider**, if analytics are enabled.

${TODO}: list the providers you have actually configured, and link to their
policies. Delete the ones you do not use.

## What we do not do

- We do not sell or rent your data.
- We do not use your data for advertising.
- The software sends no usage telemetry to its authors.

## Your rights and choices

- You can change your name, email address, and password from your account
  settings at any time.
- You can enable or disable two-factor authentication.
- You can delete your account from account settings once you no longer own any
  servers. Deleting your account removes your profile and credentials; audit log
  entries are retained with your account reference removed, because the
  operator needs an accurate record of what happened on their infrastructure.
- ${TODO}: if you are subject to the GDPR, the UK GDPR, the CCPA, or a similar
  regime, describe the access, correction, portability, erasure, and objection
  rights that apply, and how to exercise them.

## Security

Passwords are hashed, secrets are encrypted at rest, and privileged actions are
logged. No system is perfectly secure; ${TODO} describes how the operator will
notify you if a breach affects your data.

## Changes to this policy

The operator may update this policy. ${TODO}: say how users will be told.
`;
}

/**
 * A terms-of-service skeleton.
 *
 * Much shorter than the privacy draft on purpose. Terms are almost entirely
 * about the operator's own rules — acceptable use, payment, uptime, suspension
 * — and the software knows nothing about those. Inventing clauses would only
 * produce something an operator might publish unread.
 */
export function termsOfServiceTemplate(siteName: string): string {
  return `# Terms of Service

_Last updated: ${TODO}_

These terms govern your use of ${siteName}, operated by ${TODO}.

> **Operator: this is a skeleton, not a contract.** Unlike the privacy draft,
> almost nothing here can be filled in from the software — your acceptable-use
> rules, pricing, refunds, uptime commitments, and liability position are
> yours. Write each section or delete it. If you charge money or operate
> commercially, have a lawyer review the result.

## 1. Accounts

You are responsible for the security of your account and for everything done
through it. Provide accurate registration details and keep your password and
API keys confidential. ${TODO}: state any age or eligibility requirements.

## 2. Acceptable use

${TODO}: define what may and may not be run on your infrastructure. Most
operators prohibit at least: unlawful content, infringing distribution,
cryptocurrency mining, denial-of-service traffic, port scanning and other
attacks against third parties, spam relays, and attempts to escape the
container or reach other tenants.

## 3. Your content

You keep ownership of the server files, worlds, and configuration you upload.
You grant the operator only the access needed to run, back up, and support the
service. ${TODO}: state whether you take backups, how often, and how long they
are kept.

## 4. Service availability

${TODO}: state your uptime expectations, maintenance windows, and what happens
when a node fails. If you offer no guarantee, say so plainly.

## 5. Fees and billing

${TODO}: state prices, billing period, renewal, refunds, and what happens to a
suspended or unpaid server's data. Delete this section if the service is free.

## 6. Suspension and termination

The operator may suspend or terminate a server or account that breaches these
terms. ${TODO}: state whether notice is given, how long data is retained after
termination, and how a user can appeal.

## 7. Liability

${TODO}: state your limitation of liability and any disclaimer of warranties,
subject to the consumer-protection law that applies to you.

## 8. Changes to these terms

${TODO}: say how users will be told about changes and when they take effect.

## 9. Contact

${TODO}: contact address for questions and legal notices.

## Privacy

Our handling of personal data is described in the [Privacy Policy](/privacy).
`;
}
