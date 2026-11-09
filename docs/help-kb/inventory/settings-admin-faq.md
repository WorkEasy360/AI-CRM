## Settings

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Settings home (six cards + "Also in Settings:") | /settings | Sidebar → Settings | — (cards filtered per role) | — | Open any settings page | settings-overview |
| Organization details (General Settings) | /settings/general | Settings → Workspace → Organization Details | org.update | Company name*, CRM name, Base currency*, Time zone*, Date format* | Save changes, Reset | settings-organization-details |
| Workspace logo | /settings/general | Settings → Workspace → Organization Details → Logo | org.update | Image* (PNG/JPEG/WebP, 512 KB max) | Upload logo, Remove | settings-upload-logo |
| Require 2FA for all members | /settings/general | Settings → Workspace → Organization Details | org.update | Require two-factor authentication (switch) | Save changes | settings-require-2fa |
| New organization / switch organization | /settings/general | Settings → Workspace → Organization Details → Your organizations | — (any signed-in user) | Organization name*, Base currency*, Time zone* | New organization, Create organization, Open | settings-create-organization |
| Invite user | /settings/users | Settings → Workspace → Users & Teams | members.invite (team: teams.manage) | Name, Email*, Role*, Team (optional) | Invite user, Send invitation | settings-invite-user |
| Pending invitations | /settings/users | Settings → Workspace → Users & Teams | members.invite | — | Resend invitation, Revoke invitation | settings-manage-invitations |
| Change role | /settings/users | Settings → Workspace → Users & Teams → … → Change role | members.update_role | Role* | Save role | settings-change-role |
| Suspend / reactivate / revoke sessions | /settings/users | Settings → Workspace → Users & Teams → … | members.disable | — | Suspend, Reactivate, Revoke sessions | settings-suspend-user |
| Remove user | /settings/users | Settings → Workspace → Users & Teams → … → Remove user | members.remove | — | Remove user | settings-remove-user |
| Assign teams to a user | /settings/users | Settings → Workspace → Users & Teams → … → Assign team | teams.manage | Teams (checkboxes, max 20) | Save teams | settings-team-members |
| Teams | /settings/teams | Settings → Workspace → Users & Teams → Teams | teams.manage | Team name*, Manager | New team, Create team, Edit, Delete team | settings-create-team |
| Team members | /settings/teams | Settings → Workspace → Users & Teams → Teams → Members | teams.manage (view: any) | Member* | Add, Remove, Done | settings-team-members |
| Roles: profiles (system roles) | /settings/roles | Settings → Workspace → Roles & Permissions → Profiles | roles.manage (read: roles.view) | — | View grants per role | settings-roles-permissions |
| Custom profile | /settings/roles | Settings → Workspace → Roles & Permissions → Profiles | roles.manage | Name*, Copy permissions from*, access per permission | New profile, Create, Save, Delete | settings-create-custom-role |
| Role hierarchy | /settings/roles | Settings → Workspace → Roles & Permissions → Role hierarchy | roles.manage | New role*, Reports to; per-person placement; Peers switch | Add, delete level, place people | settings-role-hierarchy |
| Field permissions | /settings/roles | Settings → Workspace → Roles & Permissions → Field permissions | roles.manage | Profile*, Module*, access per field (Read & write / Read only / Hidden) | Save | settings-field-permissions |
| Change password | /settings/security | Settings → Security & Data → Password & 2FA | — | Current password*, New password* (12+), Confirm new password* | Update password | settings-change-password |
| Two-factor authentication (TOTP) | /settings/security | Settings → Security & Data → Password & 2FA | — | Confirmation code* | Set up authenticator app, Enable two-factor, Disable two-factor | settings-enable-2fa |
| Recovery codes | /settings/security | Settings → Security & Data → Password & 2FA | — | — | Show codes, Copy, Regenerate | settings-recovery-codes |
| Active sessions | /settings/security | Settings → Security & Data → Password & 2FA | — | — | Sign out, Sign out other sessions | settings-active-sessions |
| Audit log | /settings/audit-log | Settings → Security & Data → Activity / Audit Log | audit.view | Action, Actor user ID, Resource type, Since, Until | Filter, Clear filters, Details, Load more | settings-audit-log |
| Plan & usage (billing) | /settings/billing | Settings → Also in Settings → Billing & Subscription | org.billing (page visible with org.billing or org.update) | Billing cycle, Licences | Choose <plan>, Add (add-on), Remove one | settings-billing-plan |

## FAQ

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Permission denied / No access | /settings/roles | Settings → Workspace → Roles & Permissions | — | — | Ask Owner/Admin to change role | faq-permission-denied |
| Version conflict ("changed by someone else") | /contacts | Sidebar → Contacts → People (Contacts) | — | — | Reload | faq-record-changed-by-someone-else |
| Plan limits and upgrade prompt | /settings/billing | Settings → Also in Settings → Billing & Subscription | — | — | Compare plans, View add-ons, Not now | faq-plan-limits |
| Trial and billing questions | /settings/billing | Settings → Also in Settings → Billing & Subscription | — | — | — | faq-billing-trial |
| Data security and workspace isolation | /settings/security | Settings → Security & Data → Password & 2FA | — | — | — | faq-data-security |
| AI data usage / Generative AI switch | /settings/ai | Settings → AI Assistant → AI Settings | ai.settings.manage | Generative AI enabled, Monthly budget | Toggle, Save | faq-ai-data-usage |
| Forgot password | /forgot-password | CRM Login → Forgot Password? | — | Email*; New password*, Confirm new password* | Send reset link, Update password | getting-started-forgot-password |
| Locked out / lost authenticator | /login | Sign in | — | Authentication code (accepts recovery code) | — | faq-locked-out |
| Mobile / browser / install as app | /dashboard | Sidebar → Dashboard | — | — | Open navigation, bottom bar | faq-mobile-app |
| "Confirm it's you" re-authentication | /settings/security | Settings → Security & Data → Password & 2FA | — | Password* | Confirm, Cancel, Confirm with Workeasy360 | faq-confirm-its-you |

### Not in product
- Editing another member's name or email (no member profile editor; also no self-service profile/name editor).
- Admin reset of a member's two-factor authentication (a member who lost both phone and recovery codes has no in-app path).
- Admin unlock of a temporarily locked sign-in (lock expires on its own).
- Dedicated "transfer ownership" action (done by the Owner via Change role → Owner).
- Delete organization (permission `org.delete` exists, no UI).
- Passkeys / WebAuthn management in Security (backend supports it, no UI).
- Changing your sign-in email address (no UI).
- Bulk / CSV invite of users.
- Audit log export or download.
- Invoices, payment method, checkout or cancel subscription (no payment provider in the app; plan changes are direct or by the billing team).
- Native Android / iOS app in an app store (an Android wrapper exists in the repository but is not published; the web app is installable from the browser).
- Published browser-support list (none in the code).
