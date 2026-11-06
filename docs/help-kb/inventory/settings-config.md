## Settings (configuration, communication, data, integrations, automation)

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Create custom field | /settings/custom-fields | Settings → CRM Configuration → Custom Fields | customfields.manage (view: customfields.view) | Label*, Key*, Type*, Options* (dropdown/multi-select only), Help text, Required | Tabs Contacts/Companies/Deals/Products, New field, Create field | settings-custom-fields-create |
| Edit / archive / restore custom field | /settings/custom-fields | Settings → CRM Configuration → Custom Fields | customfields.manage | Label, Options, Help text, Required (Key and Type fixed) | Actions menu: Edit, Archive, Restore; Show archived switch | settings-custom-fields-edit-archive |
| Create tag | /settings/tags | Settings → CRM Configuration → Tags | tags.manage (view: tags.view) | Name* (max 40), Colour* | New tag, Create tag | settings-tags-create |
| Edit / delete tag | /settings/tags | Settings → CRM Configuration → Tags | tags.manage | Name, Colour | Actions menu: Edit, Delete | settings-tags-edit-delete |
| Connect mailbox | /settings/email | Settings → Communication → Email Settings | email.connect (page: email.view) | none (OAuth sign-in) | Connect Gmail, Connect Microsoft 365 | settings-email-connect-mailbox |
| Reconnect / disconnect mailbox | /settings/email | Settings → Communication → Email Settings | email.connect | none | Reconnect, Disconnect | settings-email-reconnect-disconnect |
| Email templates | /settings/email (also /settings/templates) | Settings → Communication → Email Settings | email.templates_manage (list: email.view) | Name*, Subject, Body*, Share with the whole team | New template, Edit, Delete, placeholder chips | settings-email-templates |
| Connect WhatsApp | /settings/whatsapp | Settings → Communication → WhatsApp Integration | whatsapp.manage (page: whatsapp.view); plan feature whatsapp (Express+); recent re-auth | Phone number ID*, Business account ID (optional), Access token* | Connect WhatsApp | settings-whatsapp-connect |
| WhatsApp webhook | /settings/whatsapp | Settings → Communication → WhatsApp Integration | whatsapp.view | none (Meta-side config; server verify token) | Copy webhook URL | settings-whatsapp-webhook |
| WhatsApp templates | /settings/whatsapp (also /settings/templates) | Settings → Communication → WhatsApp Integration | whatsapp.manage (list: whatsapp.view) | Name*, Language*, Category, Body | Add template, Remove | settings-whatsapp-add-template |
| Disconnect WhatsApp | /settings/whatsapp | Settings → Communication → WhatsApp Integration | whatsapp.manage; recent re-auth | none | Disconnect | settings-whatsapp-disconnect |
| Message Templates hub | /settings/templates | Settings → Communication → Message Templates | email.view or whatsapp.view (sections gated separately) | see email / WhatsApp templates | New template, Add template | settings-message-templates |
| Notification preferences | /settings/notifications | Settings → Communication → Notifications | notifications.view (all roles) | In-app / Email switch per event | Toggle (autosave) | settings-notifications-preferences |
| Deal inactivity warning | /settings/notifications | Settings → Communication → Notifications | notifications.view | Warn after (days) 0-365 | Save | settings-notifications-deal-inactivity |
| AI policy and budget | /settings/ai | Settings → AI Assistant → AI Settings | ai.settings.manage | Generative AI switch, Monthly budget (USD) | Toggle, Save | settings-ai-policy |
| AI usage and limits | /settings/ai (anchor usage) | Settings → AI Assistant → Usage & Limits | ai.settings.manage | read-only | View tiles, By feature, By member, Models and limits, Knowledge search | settings-ai-usage-limits |
| Import data | /settings/data | Settings → Security & Data → Import & Export Data | contacts.import / companies.import / deals.import / products.import | Record type*, File* (.csv UTF-8 or .xlsx, 5 MB, 10,000 rows, 60 columns, header row), column mapping*, Duplicates, Mapping preset, Create companies | Upload and map columns, Check file, Import | settings-import-data |
| Roll back import | /settings/data | Settings → Security & Data → Import & Export Data | <entity>.import; own import only; once | none | Roll back | settings-import-rollback |
| Export data | /settings/data | Settings → Security & Data → Import & Export Data | <entity>.export; full export needs any export permission; recent re-auth | Record type* | Request export, Export everything, Download, Download .zip | settings-export-data |
| Integrations hub | /settings/integrations | Settings → Integrations & API → Integrations (Connected Apps) | integrations.view (or webhooks.manage for nav) | none | Manage, Connect, Configure, Manage keys | settings-integrations-overview |
| Connect REST API | /settings/integrations | Settings → Integrations & API → Integrations (Connected Apps) | integrations.manage; recent re-auth | Name*, Authentication*, Base URL*, API key / Bearer token / Client ID / Client secret / Authorization URL / Token URL / Revocation URL / Scopes, Advanced | Connect, Create connection, Connect with OAuth | settings-integrations-connect-rest-api |
| Manage connection | /settings/integrations/[id] | Integrations → Manage on a card | integrations.manage (view: integrations.view) | none | Test connection, Sync now, Pause/Resume, Update credentials, Disconnect, Reconnect, Delete connection | settings-integrations-manage-connection |
| Data sharing and sync settings | /settings/integrations/[id] (Data sharing / Overview tabs) | Integrations → Manage → Data sharing | integrations.manage | Direction, API path, Field mapping (CRM field, External field), Sync frequency, conflict strategy | Add field, Save contacts/companies/deals, Save settings | settings-integrations-data-sharing |
| Resolve conflicts | /settings/integrations/[id] (Conflicts tab) | Integrations → Manage → Conflicts | integrations.manage | none | Keep CRM, Apply external | settings-integrations-conflicts |
| Inbound webhook | /settings/integrations/[id] (Inbound webhook tab) | Integrations → Manage → Inbound webhook | integrations.manage; recent re-auth | none | Enable inbound webhook, Rotate secret, Create new URL | settings-integrations-inbound-webhook |
| Connection deliveries | /settings/integrations/[id] (Deliveries tab) | Integrations → Manage → Deliveries | integrations.view | read-only (latest 50) | View | settings-integrations-manage-connection (mentioned) |
| API keys | /settings/integrations/api-keys | Settings → Integrations & API → API Keys | integrations.manage; recent re-auth | Name*, Permissions* (8 scopes), Expires (30/90/180/365 days, Never) | Create API key, Create key, Revoke | settings-api-keys |
| Create webhook | /settings/integrations/webhooks | Settings → Integrations & API → Webhooks | webhooks.manage; recent re-auth | Name*, Endpoint URL* (https), Events* (8 types), Include record fields | Add webhook, Create webhook | settings-webhooks-create |
| Manage webhook / deliveries | /settings/integrations/webhooks | Settings → Integrations & API → Webhooks | webhooks.manage | none | Send test event, Pause/Resume, Rotate secret, View deliveries, Delete | settings-webhooks-manage |
| Create automation | /settings/automation | Settings → Also in Settings: → Automation | automation.manage (view: automation.view) | Name*, When*, Stage* (stage trigger), Then*, Task title / Notification text, delay days (0-90), Only if the contact has not replied | Create Automation, ready-made rules, Create | settings-automation-create |
| WhatsApp automation | /settings/automation | Settings → Also in Settings: → Automation | automation.manage (+ whatsapp.view to list templates) | WhatsApp template*, Value for {{n}}* | Create | settings-automation-whatsapp |
| Turn off / edit / delete automation | /settings/automation | Settings → Also in Settings: → Automation | automation.manage | as create | Switch, Edit, Save, Delete | settings-automation-manage |

### Not in product
- Reordering custom fields: the Custom Fields page shows a read-only Position column; there is no drag or move control and no reorder API.
- Permanently deleting a custom field: only Archive / Restore exist.
- Editing a WhatsApp template after adding it: only Add and Remove exist (no update endpoint).
- Submitting or approving WhatsApp templates from the CRM: approval happens in Meta Business Manager; the CRM only records approved templates.
- Changing AI models or per-member / per-workspace AI limits in the app: shown read-only, set in server settings.
- Applying list filters to exports: exports always contain all records in scope.
- Importing legacy .xls files or multiple worksheets: only .csv and the first sheet of .xlsx.
- Rolling back another member's import: only the member who started it can roll it back.
- Automation triggers beyond the five listed (no time-based or field-change triggers) and actions beyond task, notify owner, notify team and WhatsApp template (no email action).
- Editing an API key's permissions or expiry after creation: revoke and create a new one.
- Editing a webhook's URL or events after creation: no edit action in the UI (only test, pause/resume, rotate secret, view deliveries, delete).
