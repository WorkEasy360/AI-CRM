---
id: helpdesk-reply-customer
title: How to Reply to a Customer on a Ticket
question: How do I reply to a customer from a ticket?
module: Helpdesk
keywords: [reply ticket, ticket reply, respond customer, email reply, whatsapp reply, conversation, ticket ka jawab, customer ko reply kaise kare, जवाब, उत्तर]
route: /helpdesk
menu_path: Helpdesk → Ticket Details → Conversation
permission: tickets.update
related: [helpdesk-internal-notes, helpdesk-resolve-close, activities-whatsapp-reply, helpdesk-create-ticket]
updated: 2026-11-06
---

## Overview
The **Conversation** tab of a ticket holds the messages between your team and the customer. You can log a reply, send it by email or WhatsApp, or record what the customer told you.

## Before you start
- You need `tickets.update` for the ticket.
- To send by email you need `email.send` and a connected mailbox; by WhatsApp you need `whatsapp.send` and a connected WhatsApp account.
- Sending by email or WhatsApp needs the ticket to be linked to a contact with an email address or phone number.

## Steps
1. Click **Helpdesk** in the left sidebar.
2. Click the ticket's ID or subject to open **Ticket Details**.
3. Make sure the **Conversation** tab is selected.
4. Type your message in **Type your reply…**.
5. Open the **Send as** list and choose **Reply (log only)**, **Reply by email**, **Reply by WhatsApp** or **Log customer message**.
6. Click the **Send** button.

## Result
The message appears in the conversation. "Reply sent by email" or "Reply sent on WhatsApp" confirms an outgoing reply. The first reply to an **Open** ticket moves it to **In Progress**.

## Tips
- Click **Attach a file** to add a file to the ticket; see it under **Attachments**.
- Use **Insert emoji** for a quick emoji.
- WhatsApp free-text replies work only within 24 hours of the customer's last message.

## Troubleshooting
- **"Link the ticket to a contact to send replies."** The ticket has only a requester name. Use **Reply (log only)** or create the ticket for a contact.
- **"This contact has no email address."** Add an email address to the contact first.
