async function dashboard(req, res) {
  return res.json({
    message: 'Accountant dashboard',
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
    },
  });
}

module.exports = { dashboard };
