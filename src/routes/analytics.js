const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount } = require('../utils/formatAmount');

const router = express.Router();

// MySQL ONLY_FULL_GROUP_BY: SELECT non-aggregates must match GROUP BY expressions.
const getPeriodGroupExpr = (period) => {
  if (period === 'daily') return "DATE_FORMAT(t.date, '%Y-%m-%d')";
  if (period === 'weekly') {
    return "CONCAT(YEAR(t.date), '-W', LPAD(WEEK(t.date, 1), 2, '0'))";
  }
  return "DATE_FORMAT(t.date, '%Y-%m')";
};

// Get debit/credit analytics for charts
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const { period = 'monthly', startDate, endDate } = req.query;

    const periodExpr = getPeriodGroupExpr(period);

    let dateFilter = '';
    const params = [];
    if (startDate && endDate) {
      dateFilter = 'WHERE t.date >= ? AND t.date <= ?';
      params.push(startDate, endDate);
    }

    const query = `
      SELECT 
        ${periodExpr} as period,
        t.type,
        SUM(t.amount) as total_amount,
        COUNT(*) as transaction_count
      FROM transactions t
      ${dateFilter}
      GROUP BY ${periodExpr}, t.type
      ORDER BY period DESC, t.type
    `;

    const result = await pool.query(query, params);

    const formattedData = {
      labels: [],
      datasets: [
        { label: 'Debit', data: [], backgroundColor: 'rgba(239, 68, 68, 0.8)', borderColor: 'rgba(239, 68, 68, 1)', borderWidth: 1 },
        { label: 'Credit', data: [], backgroundColor: 'rgba(34, 197, 94, 0.8)', borderColor: 'rgba(34, 197, 94, 1)', borderWidth: 1 }
      ]
    };

    const periodData = {};
    result.rows.forEach(row => {
      if (!periodData[row.period]) periodData[row.period] = { Debit: 0, Credit: 0 };
      periodData[row.period][row.type] = parseFloat(row.total_amount);
    });

    Object.keys(periodData).sort().forEach(p => {
      formattedData.labels.push(p);
      formattedData.datasets[0].data.push(formatAmount(periodData[p].Debit || 0));
      formattedData.datasets[1].data.push(formatAmount(periodData[p].Credit || 0));
    });

    const totalDebit = result.rows.filter(r => r.type === 'Debit').reduce((sum, r) => sum + parseFloat(r.total_amount), 0);
    const totalCredit = result.rows.filter(r => r.type === 'Credit').reduce((sum, r) => sum + parseFloat(r.total_amount), 0);

    res.json({
      success: true,
      period: period,
      data: formattedData,
      summary: {
        totalDebit: formatAmount(totalDebit),
        totalCredit: formatAmount(totalCredit),
        totalTransactions: result.rows.reduce((sum, r) => sum + parseInt(r.transaction_count), 0)
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch transaction analytics' });
  }
});

// Get monthly summary
router.get('/monthly-summary', authenticateToken, async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    const query = `
      SELECT 
        DATE_FORMAT(t.date, '%b %Y') as month,
        DATE_FORMAT(t.date, '%Y-%m') as month_sort,
        t.type,
        SUM(t.amount) as total_amount,
        COUNT(*) as count
      FROM transactions t
      WHERE YEAR(t.date) = ?
      GROUP BY DATE_FORMAT(t.date, '%Y-%m'), DATE_FORMAT(t.date, '%b %Y'), t.type
      ORDER BY DATE_FORMAT(t.date, '%Y-%m') ASC, t.type
    `;

    const result = await pool.query(query, [year]);

    const monthlyData = {};
    result.rows.forEach(row => {
      if (!monthlyData[row.month_sort]) {
        monthlyData[row.month_sort] = { month: row.month, Debit: 0, Credit: 0 };
      }
      monthlyData[row.month_sort][row.type] = parseFloat(row.total_amount);
    });

    const chartData = { labels: [], debit: [], credit: [] };
    Object.keys(monthlyData).sort().forEach(key => {
      chartData.labels.push(monthlyData[key].month);
      chartData.debit.push(formatAmount(monthlyData[key].Debit));
      chartData.credit.push(formatAmount(monthlyData[key].Credit));
    });

    res.json({ success: true, year: parseInt(year), data: chartData, raw: monthlyData });
  } catch (error) {
    console.error('Error fetching monthly summary:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch monthly summary' });
  }
});

// Get category-wise summary
router.get('/category-summary', authenticateToken, async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;

    let dateFilter = '';
    const params = [];
    if (startDate && endDate) {
      dateFilter = 'WHERE t.date >= ? AND t.date <= ?';
      params.push(startDate, endDate);
    }
    if (type) {
      dateFilter += dateFilter ? ' AND' : 'WHERE';
      dateFilter += ' t.type = ?';
      params.push(type);
    }

    const query = `
      SELECT 
        COALESCE(pc.name, rc.name, 'Uncategorized') as category_name,
        t.type,
        SUM(t.amount) as total_amount,
        COUNT(*) as transaction_count
      FROM transactions t
      LEFT JOIN payables_categories pc ON t.category_id = pc.id AND t.category_type = 'payable'
      LEFT JOIN receivables_categories rc ON t.category_id = rc.id AND t.category_type = 'receivable'
      ${dateFilter}
      GROUP BY COALESCE(pc.name, rc.name, 'Uncategorized'), t.type
      ORDER BY total_amount DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows.map(row => ({
        category: row.category_name,
        type: row.type,
        totalAmount: formatAmount(row.total_amount),
        transactionCount: parseInt(row.transaction_count)
      }))
    });
  } catch (error) {
    console.error('Error fetching category summary:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch category summary' });
  }
});

// Get balance trend over time
router.get('/balance-trend', authenticateToken, async (req, res) => {
  try {
    const { period = 'monthly', limit = 12 } = req.query;

    const periodExpr = getPeriodGroupExpr(period);

    const query = `
      SELECT 
        ${periodExpr} as period,
        MAX(t.balance) as closing_balance,
        MIN(t.balance) as opening_balance,
        COUNT(*) as transaction_count
      FROM transactions t
      GROUP BY ${periodExpr}
      ORDER BY period DESC
      LIMIT ?
    `;

    const result = await pool.query(query, [parseInt(limit)]);

    const trendData = { labels: [], balances: [], openingBalances: [], closingBalances: [] };

    result.rows.reverse().forEach(row => {
      let label;
      if (period === 'daily') {
        const date = new Date(`${row.period}T12:00:00`);
        label = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      } else if (period === 'weekly') {
        label = String(row.period);
      } else {
        const date = new Date(`${row.period}-01T12:00:00`);
        label = date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      }
      trendData.labels.push(label);
      trendData.balances.push(formatAmount(row.closing_balance));
      trendData.openingBalances.push(formatAmount(row.opening_balance));
      trendData.closingBalances.push(formatAmount(row.closing_balance));
    });

    res.json({ success: true, period: period, data: trendData });
  } catch (error) {
    console.error('Error fetching balance trend:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch balance trend' });
  }
});

module.exports = router;
