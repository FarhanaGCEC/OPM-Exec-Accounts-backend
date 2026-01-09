# Credit Card Statement Management API Documentation

## Overview
Complete backend API for company credit card monthly statement management system using Node.js, Express, PostgreSQL, and JWT authentication.

## Database Schema

### Tables

#### 1. credit_cards_new
- `id` (UUID, Primary Key)
- `issuing_bank` (VARCHAR)
- `card_holder` (VARCHAR)
- `card_number` (VARCHAR(50))
- `expiry_date` (DATE)
- `credit_limit` (DECIMAL)
- `is_active` (BOOLEAN)
- `created_at` (TIMESTAMP)
- `updated_at` (TIMESTAMP)

#### 2. card_statements
- `id` (UUID, Primary Key)
- `credit_card_id` (UUID, FK → credit_cards_new.id)
- `statement_month` (VARCHAR(7), format: YYYY-MM)
- `statement_date` (DATE)
- `due_date` (DATE)
- `total_due` (DECIMAL)
- `paid_amount` (DECIMAL)
- `pending_amount` (DECIMAL, auto-calculated)
- `epp_balance` (DECIMAL)
- `balance_transfer` (DECIMAL)
- `payment_status` (ENUM: PAID, PARTIAL, OVERDUE, auto-calculated)
- `created_at` (TIMESTAMP)
- `updated_at` (TIMESTAMP)

**Unique Constraint:** `(credit_card_id, statement_month)`

## Business Logic

### Auto-calculation Rules

1. **pending_amount** = `total_due - paid_amount`
2. **payment_status**:
   - `PAID` → `pending_amount = 0`
   - `PARTIAL` → `pending_amount > 0` AND `due_date >= today`
   - `OVERDUE` → `pending_amount > 0` AND `due_date < today`

### Statement Initialization
- When initializing statements for a month, auto-creates statements for all active credit cards
- Prevents duplicates using unique constraint
- Uses database transaction for atomicity
- Default `statement_date`: First day of month
- Default `due_date`: 25th of month (or last day if 25th doesn't exist)

## API Endpoints

All endpoints require JWT authentication via `Authorization: Bearer <token>` header.

### Cards API

#### 1. Create Card
**POST** `/api/cards`

**Request Body:**
```json
{
  "issuing_bank": "Emirates NBD",
  "card_holder": "John Doe",
  "card_number": "5313 9800 0593 7036",
  "expiry_date": "Feb-28",
  "credit_limit": 50000,
  "is_active": true
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Credit card created successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "issuing_bank": "Emirates NBD",
    "card_holder": "John Doe",
    "card_number": "5313 9800 0593 7036",
    "expiry_date": "Feb-28",
    "credit_limit": "50000.00",
    "is_active": true,
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z"
  }
}
```

#### 2. List Cards
**GET** `/api/cards?include_inactive=false`

**Query Parameters:**
- `include_inactive` (optional): `true` to include inactive cards

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "issuing_bank": "Emirates NBD",
      "card_holder": "John Doe",
      "card_number": "5313 9800 0593 7036",
      "expiry_date": "Feb-28",
      "credit_limit": "50000.00",
      "is_active": true,
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

#### 3. Get Single Card
**GET** `/api/cards/:id`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "issuing_bank": "Emirates NBD",
    "card_holder": "John Doe",
    "card_number": "5313 9800 0593 7036",
    "expiry_date": "Feb-28",
    "credit_limit": "50000.00",
    "is_active": true,
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z"
  }
}
```

#### 4. Update Card
**PUT** `/api/cards/:id`

**Request Body (all fields optional):**
```json
{
  "issuing_bank": "Updated Bank Name",
  "card_holder": "Updated Name",
  "card_number": "5678",
  "expiry_date": "2026-12-31",
  "credit_limit": 60000,
  "is_active": false
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Credit card updated successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "issuing_bank": "Updated Bank Name",
    "card_holder": "Updated Name",
    "card_number": "5678",
    "expiry_date": "2026-12-31",
    "credit_limit": "60000.00",
    "is_active": false,
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-16T10:30:00.000Z"
  }
}
```

#### 5. Deactivate Card
**DELETE** `/api/cards/:id`

**Response (200):**
```json
{
  "success": true,
  "message": "Credit card deactivated successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "issuing_bank": "Emirates NBD",
    "card_holder": "John Doe",
    "card_number": "5313 9800 0593 7036",
    "expiry_date": "Feb-28",
    "credit_limit": "50000.00",
    "is_active": false,
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-16T10:30:00.000Z"
  }
}
```

### Statements API

#### 1. Initialize Statements for Month
**POST** `/api/statements/init/:month`

**Path Parameter:**
- `month`: Format `YYYY-MM` (e.g., `2024-02`)

**Response (201):**
```json
{
  "success": true,
  "message": "Statements initialized for 2024-02",
  "data": {
    "created": [
      {
        "id": "b2c3d4e5-f6g7-8901-bcde-f12345678901",
        "credit_card_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "statement_month": "2024-02",
        "issuing_bank": "Emirates NBD",
        "card_holder": "John Doe"
      }
    ],
    "skipped": [],
    "totalCreated": 1,
    "totalSkipped": 0
  }
}
```

#### 2. List Statements
**GET** `/api/statements/:month?card_id=<uuid>`

**Path Parameter:**
- `month`: Format `YYYY-MM` (e.g., `2024-02`) or `all` for all statements

**Query Parameter:**
- `card_id` (optional): Filter by card ID

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "b2c3d4e5-f6g7-8901-bcde-f12345678901",
      "credit_card_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "statement_month": "2024-02",
      "statement_date": "2024-02-01",
      "due_date": "2024-02-25",
      "total_due": "5,000.00",
      "paid_amount": "3,000.00",
      "pending_amount": "2,000.00",
      "epp_balance": "0.00",
      "balance_transfer": "0.00",
      "payment_status": "PARTIAL",
      "issuing_bank": "Emirates NBD",
      "card_holder": "John Doe",
      "card_number": "5313 9800 0593 7036",
      "created_at": "2024-02-01T10:30:00.000Z",
      "updated_at": "2024-02-15T10:30:00.000Z"
    }
  ],
  "count": 1,
  "filters": {
    "month": "2024-02",
    "cardId": null
  }
}
```

#### 3. Get Single Statement
**GET** `/api/statements/detail/:id`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "b2c3d4e5-f6g7-8901-bcde-f12345678901",
    "credit_card_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "statement_month": "2024-02",
    "statement_date": "2024-02-01",
    "due_date": "2024-02-25",
    "total_due": "5,000.00",
    "paid_amount": "3,000.00",
    "pending_amount": "2,000.00",
    "epp_balance": "0.00",
    "balance_transfer": "0.00",
    "payment_status": "PARTIAL",
    "issuing_bank": "Emirates NBD",
    "card_holder": "John Doe",
    "card_number": "5313 9800 0593 7036",
    "created_at": "2024-02-01T10:30:00.000Z",
    "updated_at": "2024-02-15T10:30:00.000Z"
  }
}
```

#### 4. Update Statement
**PUT** `/api/statements/:id`

**Request Body (all fields optional):**
```json
{
  "statement_date": "2024-02-01",
  "due_date": "2024-02-25",
  "total_due": 5000,
  "paid_amount": 4000,
  "epp_balance": 500,
  "balance_transfer": 0
}
```

**Note:** `pending_amount` and `payment_status` are automatically recalculated based on the values provided.

**Response (200):**
```json
{
  "success": true,
  "message": "Statement updated successfully",
  "data": {
    "id": "b2c3d4e5-f6g7-8901-bcde-f12345678901",
    "credit_card_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "statement_month": "2024-02",
    "statement_date": "2024-02-01",
    "due_date": "2024-02-25",
    "total_due": "5,000.00",
    "paid_amount": "4,000.00",
    "pending_amount": "500.00",
    "epp_balance": "500.00",
    "balance_transfer": "0.00",
    "payment_status": "PARTIAL",
    "issuing_bank": "Emirates NBD",
    "card_holder": "John Doe",
    "card_number": "5313 9800 0593 7036",
    "created_at": "2024-02-01T10:30:00.000Z",
    "updated_at": "2024-02-16T10:30:00.000Z"
  }
}
```

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "Validation error message"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Resource not found"
}
```

### 409 Conflict
```json
{
  "success": false,
  "error": "Statement already exists for this card and month"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Internal server error message"
}
```

## Validation Rules

1. **card_number**: Must be a valid card number (13-19 digits, spaces allowed, e.g., "5313 9800 0593 7036")
2. **expiry_date**: Must be in MMM-YY format (e.g., "Feb-28", "Dec-29")
3. **statement_month**: Must be in YYYY-MM format
4. **Numeric fields**: All amounts must be >= 0
5. **expiry_date**: Must be in MMM-YY format (e.g., "Feb-28", "Dec-29")
6. **Other dates (statement_date, due_date)**: Must be valid ISO date strings (YYYY-MM-DD)

## Example Usage Flow

1. **Create a card:**
   ```bash
   POST /api/cards
   ```

2. **Initialize statements for February 2024:**
   ```bash
   POST /api/statements/init/2024-02
   ```
   This creates statements for all active cards.

3. **Update statement with payment details:**
   ```bash
   PUT /api/statements/{statement-id}
   {
     "total_due": 5000,
     "paid_amount": 3000,
     "due_date": "2024-02-25"
   }
   ```
   The system automatically calculates:
   - `pending_amount` = 2000
   - `payment_status` = "PARTIAL" (since due_date >= today)

4. **Mark as fully paid:**
   ```bash
   PUT /api/statements/{statement-id}
   {
     "paid_amount": 5000
   }
   ```
   System automatically updates:
   - `pending_amount` = 0
   - `payment_status` = "PAID"

5. **List all statements for February:**
   ```bash
   GET /api/statements/2024-02
   ```

## Production Considerations

- All endpoints are protected with JWT authentication
- Database transactions ensure data integrity
- Auto-calculation prevents manual errors
- Unique constraints prevent duplicate statements
- All numeric validations prevent negative values
- Error handling provides clear error messages
