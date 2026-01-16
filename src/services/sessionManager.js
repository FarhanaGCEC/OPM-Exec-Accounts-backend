/**
 * Session Manager
 * Tracks last activity time for each JWT token to implement inactivity-based session expiration
 */
class SessionManager {
  constructor() {
    // Map to store token -> lastActivityTimestamp
    // Format: { token: timestamp }
    this.sessions = new Map();
    
    // Inactivity timeout: 30 minutes in milliseconds
    this.INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    
    // Cleanup interval: run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
  }

  /**
   * Update last activity time for a token
   * @param {string} token - JWT token
   */
  updateActivity(token) {
    this.sessions.set(token, Date.now());
  }

  /**
   * Check if a token is still active (has been used within the inactivity timeout)
   * @param {string} token - JWT token
   * @returns {boolean} - true if active, false if expired due to inactivity
   */
  isActive(token) {
    const lastActivity = this.sessions.get(token);
    
    // If token not in sessions map, it's a new token - consider it active
    if (!lastActivity) {
      return true;
    }
    
    const now = Date.now();
    const timeSinceLastActivity = now - lastActivity;
    
    // Check if inactive for more than 30 minutes
    return timeSinceLastActivity <= this.INACTIVITY_TIMEOUT;
  }

  /**
   * Remove a token from active sessions (e.g., on logout)
   * @param {string} token - JWT token
   */
  removeSession(token) {
    this.sessions.delete(token);
  }

  /**
   * Clean up expired sessions (tokens inactive for more than 30 minutes)
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredTokens = [];
    
    for (const [token, lastActivity] of this.sessions.entries()) {
      const timeSinceLastActivity = now - lastActivity;
      if (timeSinceLastActivity > this.INACTIVITY_TIMEOUT) {
        expiredTokens.push(token);
      }
    }
    
    // Remove expired tokens
    expiredTokens.forEach(token => this.sessions.delete(token));
    
    if (expiredTokens.length > 0) {
      console.log(`Cleaned up ${expiredTokens.length} expired session(s)`);
    }
  }

  /**
   * Get the number of active sessions
   * @returns {number}
   */
  getActiveSessionCount() {
    return this.sessions.size;
  }

  /**
   * Clear all sessions (useful for testing or server restart)
   */
  clearAllSessions() {
    this.sessions.clear();
  }

  /**
   * Stop the cleanup interval (useful for graceful shutdown)
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Export singleton instance
module.exports = new SessionManager();
