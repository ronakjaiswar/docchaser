# DocChaser 🚀

**WhatsApp-first document collection & tracking SaaS for small CA firms.**

DocChaser helps Chartered Accountant firms collect client documents (GST invoices, bank statements, ITR papers) without endless WhatsApp chasing, phone calls, and Excel sheets.

---

## 🎯 Problem

Small CA firms (1–10 people) in India spend **10–15 hours per week** chasing clients for documents — GST invoices, purchase bills, bank statements, Form 16 — via WhatsApp, calls, and emails.

- Clients delay sending documents
- Deadlines get missed → penalties
- Excel sheets become messy
- No visibility into what's pending vs received

Existing tools (Zoho, ClearTax, Vyapar) focus on **filing and accounting**. Nobody solves the **document collection workflow** for small firms.

---

## 💡 Solution

**DocChaser** is a lightweight web app where:

1. CA firm adds clients
2. Clicks **"Request Docs"** → system generates a unique upload link
3. WhatsApp opens with a prefilled message containing the link
4. Client clicks link → uploads files from phone (no login, no app)
5. CA firm's dashboard shows status: **Pending** / **Received** with file count
6. CA firm views/downloads all documents from client detail page

No client portal. No app download. No login for clients. **WhatsApp is the portal.**

---

## ✨ Features (MVP)

- 🔐 **Auth** — Email/password signup & login for CA firms
- 👥 **Client Management** — Add clients with name + WhatsApp number
- 📤 **Document Requests** — One-click WhatsApp link generation with unique token
- 📱 **Public Upload Page** — Mobile-first, no-login upload (PDF, JPG, PNG, max 10MB)
- 📊 **Status Tracking** — Pending / Received badges with file count
- 📁 **Document Viewer** — Client detail page with download links
- 🎨 **Clean UI** — Tailwind CSS, mobile responsive

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Node.js + Express |
| **Templating** | EJS (server-side rendering) |
| **Database** | Supabase (PostgreSQL) |
| **Auth** | Supabase Auth (admin API) |
| **File Storage** | Supabase Storage |
| **Session** | express-session |
| **File Upload** | multer (memory storage) |
| **Styling** | Tailwind CSS (CDN) |
| **WhatsApp** | `wa.me` deep link (no API cost) |

---

## 📁 Project Structure
