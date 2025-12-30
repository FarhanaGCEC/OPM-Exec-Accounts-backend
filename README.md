# GCEC Account System Backend

A Node.js backend application for the GCEC Account System.

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- PostgreSQL (v12 or higher)

### Installation

1. **Install PostgreSQL** (if not already installed):
   - macOS: `brew install postgresql@14`
   - Ubuntu: `sudo apt-get install postgresql postgresql-contrib`
   - Windows: Download from [PostgreSQL website](https://www.postgresql.org/download/)

2. **Create a PostgreSQL database**:
   ```bash
   # Connect to PostgreSQL
   psql -U postgres
   
   # Create database
   CREATE DATABASE gcec_account_system;
   
   # Exit psql
   \q
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Set up environment variables** (create a `.env` file):
   ```bash
   PORT=3000
   JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=gcec_account_system
   DB_USER=postgres
   DB_PASSWORD=postgres
   ```

5. **Start the development server**:
   ```bash
   npm run dev
   ```

6. **Start the production server**:
   ```bash
   npm start
   ```

## Project Structure

```
.
├── src/
│   ├── index.js          # Main application entry point
│   ├── config/
│   │   └── database.js   # PostgreSQL database configuration
│   ├── routes/
│   │   └── auth.js       # Authentication routes (signup, login)
│   ├── middleware/
│   │   └── auth.js       # JWT authentication middleware
│   └── models/
│       └── User.js       # User model (PostgreSQL)
├── package.json          # Project dependencies and scripts
├── .gitignore           # Git ignore file
└── README.md            # Project documentation
```

## Database

The application uses PostgreSQL for data storage. The database schema is automatically created when the server starts. The `users` table includes:
- `id` (SERIAL PRIMARY KEY)
- `username` (VARCHAR, UNIQUE)
- `password` (VARCHAR - hashed)
- `created_at` (TIMESTAMP)

## API Endpoints

### Public Endpoints

- `GET /` - Welcome message
- `GET /health` - Health check endpoint
- `POST /api/auth/signup` - User registration
- `POST /api/auth/login` - User login

### Protected Endpoints

- `GET /api/profile` - Get user profile (requires JWT token)

## Authentication

### Signup

**POST** `/api/auth/signup`

Request body:
```json
{
  "username": "john_doe",
  "password": "password123"
}
```

Response:
```json
{
  "message": "User created successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "john_doe"
  }
}
```

### Login

**POST** `/api/auth/login`

Request body:
```json
{
  "username": "john_doe",
  "password": "password123"
}
```

Response:
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "john_doe"
  }
}
```

### Using Protected Routes

Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-token>
```

Example:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/profile
```

## License

ISC

# GCEC-Account-backend
