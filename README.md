# PROPATI Backend API

Nigeria's verified property platform — backend API server.

Built with: **Node.js + Express + SQLite (better-sqlite3)**  
Integrations: **Paystack · NIMC · Twilio · Sendgrid**

---

## Quick Start (Local)

### Prerequisites
- Node.js 18+ ([nodejs.org](https://nodejs.org))
- npm (comes with Node)

### 1. Install dependencies
```bash
cd propati-backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Open `.env` and set at minimum:
```
JWT_SECRET=any_long_random_string_here_at_least_64_chars
JWT_REFRESH_SECRET=another_long_random_string_here
```
Generate secure secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Seed demo data
```bash
npm run seed
```

### 4. Start the server
```bash
npm run dev   # development (auto-restarts on changes)
npm start     # production
```

Server runs at: **http://localhost:3000**  
Health check: **http://localhost:3000/health**

### Demo Accounts (after seeding)
| Role | Email | Password |
|------|-------|----------|
| Admin | admin@propati.ng | Admin1234! |
| Landlord | chidi@propati.ng | Chidi1234! |
| Tenant | adaeze@propati.ng | Adaeze1234! |
| Agent | akin@propati.ng | Akin1234! |

---

## API Reference

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/signup` | Register new account |
| POST | `/api/auth/login` | Login → get tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Invalidate tokens |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/kyc/nin` | Verify NIN via NIMC |
| PATCH | `/api/auth/password` | Change password |

### Listings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/listings` | Search listings (public) |
| GET | `/api/listings/:id` | Get listing detail |
| POST | `/api/listings` | Create listing (landlord/agent) |
| PATCH | `/api/listings/:id` | Update listing |
| DELETE | `/api/listings/:id` | Delete listing |
| POST | `/api/listings/:id/images` | Upload images |
| POST | `/api/listings/:id/save` | Save/unsave listing |
| GET | `/api/listings/owner/mine` | My listings |
| POST | `/api/listings/:id/flag` | Flag suspicious listing |

**Search query params:** `type`, `area`, `state`, `min_price`, `max_price`, `bedrooms`, `verified`, `q`, `page`, `limit`, `sort`

### Verification (5-Layer)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/verification/:listingId` | Get verification status |
| POST | `/api/verification/:listingId/layer1` | Upload property documents |
| POST | `/api/verification/:listingId/layer2` | Submit identity proof |
| POST | `/api/verification/:listingId/layer3/generate-qr` | Get QR code for video |
| POST | `/api/verification/:listingId/layer3/upload` | Upload QR video |
| POST | `/api/verification/:listingId/layer1/review` | Admin: approve/reject layer 1 |
| POST | `/api/verification/:listingId/layer2/review` | Admin: approve/reject layer 2 |
| POST | `/api/verification/:listingId/layer3/review` | Admin: approve/reject layer 3 |
| POST | `/api/verification/:listingId/layer4/schedule` | Admin: schedule agent inspection |
| POST | `/api/verification/:listingId/layer4/complete` | Agent: mark inspection complete |
| POST | `/api/verification/:listingId/layer5/certify` | Admin: grant Certified badge |

### Payments & Escrow
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/initiate` | Initiate payment (goes to escrow) |
| POST | `/api/payments/verify/:ref` | Verify Paystack payment |
| POST | `/api/payments/webhook` | Paystack webhook handler |
| POST | `/api/payments/:txnId/release` | Admin: release escrow |
| GET | `/api/payments/my-transactions` | User's transaction history |
| POST | `/api/payments/:txnId/dispute` | Dispute a transaction |

### Agreements
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agreements` | Create lease agreement |
| GET | `/api/agreements/:id` | Get agreement detail |
| GET | `/api/agreements/user/my` | My agreements |
| POST | `/api/agreements/:id/sign` | Sign agreement (e-signature) |
| GET | `/api/agreements/:id/schedule` | Rent payment schedule |
| POST | `/api/agreements/:id/pay-rent` | Initiate rent payment |
| POST | `/api/agreements/:id/terminate` | Terminate agreement |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/profile` | My profile |
| PATCH | `/api/users/profile` | Update profile |
| GET | `/api/users/notifications` | My notifications |
| POST | `/api/users/notifications/read-all` | Mark all read |
| GET | `/api/users/saved-listings` | Saved listings |
| GET | `/api/users/agents` | Browse agents |
| GET | `/api/users/admin/all` | Admin: all users |
| POST | `/api/users/admin/:id/suspend` | Admin: suspend user |
| POST | `/api/users/admin/:id/approve-agent` | Admin: approve agent |
| GET | `/api/users/admin/stats` | Admin: platform stats |

---

## Deployment

### Option A: Railway (Recommended — easiest)

1. Create a free account at [railway.app](https://railway.app)
2. Connect your GitHub account
3. Push this project to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "PROPATI backend initial commit"
   git remote add origin https://github.com/YOURUSERNAME/propati-backend.git
   git push -u origin main
   ```
4. In Railway: **New Project → Deploy from GitHub → select your repo**
5. Add environment variables in Railway dashboard (copy from `.env.example`)
6. Railway auto-deploys. Your API will be at: `https://propati-backend-xxx.railway.app`

**Cost:** Free tier gives you $5/month of credits — enough for a small production app.

---

### Option B: Render

1. Create account at [render.com](https://render.com)
2. Push to GitHub (same as above)
3. New → Web Service → Connect repo
4. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** `Node`
5. Add environment variables
6. Deploy

**Cost:** Free tier available (spins down after inactivity). Paid from $7/month.

---

### Option C: VPS (DigitalOcean / Hetzner / AWS EC2)

Best for production. Hetzner is cheapest (~€4/month for 2 vCPU, 4GB RAM).

```bash
# 1. SSH into your server
ssh root@YOUR_SERVER_IP

# 2. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install PM2 (process manager)
npm install -g pm2

# 4. Clone your repo
git clone https://github.com/YOURUSERNAME/propati-backend.git
cd propati-backend

# 5. Install dependencies
npm install --production

# 6. Set up environment
cp .env.example .env
nano .env    # fill in your values

# 7. Seed database
npm run seed

# 8. Start with PM2 (stays running, auto-restarts)
pm2 start src/index.js --name propati-api
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot

# 9. Set up Nginx as reverse proxy (optional but recommended)
apt install nginx -y
```

**Nginx config** (`/etc/nginx/sites-available/propati`):
```nginx
server {
    listen 80;
    server_name api.propati.ng;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    # Increase upload size for property documents/videos
    client_max_body_size 100M;
}
```

```bash
# Enable site and get SSL
ln -s /etc/nginx/sites-available/propati /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Free SSL with Certbot
apt install certbot python3-certbot-nginx -y
certbot --nginx -d api.propati.ng
```

---

## Connecting the Frontend

Once deployed, update the frontend HTML to call your real API instead of mocking data.

In the unified app, find where login/signup is called and replace with:

```javascript
const API_BASE = 'https://your-api-url.railway.app/api';

// Example: login
async function apiLogin(email, password, role) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (data.success) {
    localStorage.setItem('propati_token', data.access_token);
    // setState with real user data
  }
}

// Example: fetch listings
async function fetchListings(filters = {}) {
  const params = new URLSearchParams(filters);
  const res = await fetch(`${API_BASE}/listings?${params}`);
  return await res.json();
}
```

---

## Third-Party Setup

### Paystack (Payments)
1. Create account at [paystack.com](https://paystack.com)
2. Go to Settings → API Keys
3. Copy your **Secret Key** and **Public Key** to `.env`
4. For webhooks: Settings → Webhooks → Add `https://your-api-url/api/payments/webhook`

### NIMC (NIN Verification)
1. Visit [nimc.gov.ng/developers](https://nimc.gov.ng)
2. Apply for API access (takes 2–4 weeks)
3. Use the mock mode in dev — any NIN starting with `9` will pass

### Twilio (SMS)
1. Create account at [twilio.com](https://twilio.com)
2. Get a Nigerian phone number (~$1/month)
3. Copy Account SID, Auth Token, and phone number to `.env`

### Sendgrid (Email)
1. Create account at [sendgrid.com](https://sendgrid.com)
2. Create an API key
3. Verify your sender domain (`propati.ng`)

---

## Database

The database (`propati.db`) is created automatically on first run in the project root.

**To back up:** `cp propati.db propati.db.backup`

**To reset:** `rm propati.db && npm run seed`

On Railway/Render, mount a persistent volume at your `DB_PATH` to preserve data across deploys.

---

## File Uploads

Uploaded files are stored in `./uploads/` with subdirectories:
- `uploads/images/` — property photos
- `uploads/documents/` — verification documents, PDFs
- `uploads/videos/` — QR proof videos

In production, move uploads to **AWS S3** or **Cloudinary** for persistence and CDN delivery. Update `src/middleware/upload.js` to use `multer-s3`.

---

## Password Rules
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 number

---

## Support

Built for PROPATI Technologies Ltd.  
Nigeria's most trusted property platform.  
Contact: dev@propati.ng
