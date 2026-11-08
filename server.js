

require("dotenv").config();
const { Pool } = require("pg");
const { Resend } = require("resend");
const Razorpay = require("razorpay");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");
const app = express();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const NOTES_DIR = path.join(__dirname, "uploads", "notes");

fs.mkdirSync(NOTES_DIR, { recursive: true });

const noteUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, NOTES_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    const valid =
      (ext === ".pdf" && file.mimetype === "application/pdf") ||
      ((ext === ".jpg" || ext === ".jpeg") &&
        file.mimetype === "image/jpeg");

    if (!valid) {
      return cb(new Error("Sirf PDF ya JPG/JPEG file upload karein."));
    }

    cb(null, true);
  }
});

function handleNoteUpload(req, res, next) {
  noteUpload.single("file")(req, res, (error) => {
    if (error) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "File ka size 10 MB se kam hona chahiye."
          : error.message;

      return res.status(400).json({ error: message });
    }

    next();
  });
}

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "data.json");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix);
  }
});
const upload = multer({ storage: storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
  connectionTimeoutMillis: 10000
});

console.log(
  "DATABASE_URL loaded:",
  Boolean(process.env.DATABASE_URL)
);

console.log(
  "DATABASE_URL host:",
  process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL).hostname
    : "MISSING"
);


pool.query("SELECT NOW() AS server_time")
  .then(result => {
    console.log("PostgreSQL connected successfully!");
    console.log("Database time:", result.rows[0].server_time);
  })
  .catch(error => {
    console.error("PostgreSQL connection failed:");
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
  });


if (process.env.NODE_ENV === "production" &&
    (!process.env.SESSION_SECRET ||
     process.env.SESSION_SECRET.length < 32)) {
  throw new Error("Production mein SESSION_SECRET ko 32+ characters ka rakhein.");
}

const SESSION_SECRET = process.env.SESSION_SECRET ||
  "local-development-only-change-this-secret-123456789";

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);
app.use(session({
  name: "champion.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function makeId(prefix) {
  return prefix + "_" + Date.now().toString(36) +
    "_" + Math.random().toString(36).slice(2, 9);
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


let db = {
  users: [],
  students: [],
  attendance: [],
  tests: [],
  submissions: [],
  results: [],
  fees: [],
  notices: [],
  otps: [],
  notes: [],
  paymentOrders: []
};

async function loadDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS champion_app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pool.query(
    "SELECT data FROM champion_app_state WHERE id = 1"
  );

  if (result.rows.length > 0) {
    db = result.rows[0].data;

    for (const key of [
      "users",
      "students",
      "attendance",
      "tests",
      "submissions",
      "results",
      "fees",
      "notices",
      "otps",
           "notes",
      "paymentOrders"
    ]) {
      if (!Array.isArray(db[key])) {
        db[key] = [];
      }
    }

    console.log("Application data PostgreSQL se load ho gaya.");
    return;
  }

  // PostgreSQL mein record nahi hai, to data.json se import karo.
  const initialData = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    : db;

  for (const key of [
    "users",
    "students",
    "attendance",
    "tests",
    "submissions",
    "results",
    "fees",
    "notices",
    "otps",
    "notes"
  ]) {
    if (!Array.isArray(initialData[key])) {
      initialData[key] = [];
    }
  }

  await pool.query(
    `INSERT INTO champion_app_state (id, data)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(initialData)]
  );

  const saved = await pool.query(
    "SELECT data FROM champion_app_state WHERE id = 1"
  );

  db = saved.rows[0].data;

  if (!Array.isArray(db.notes)) {
    db.notes = [];
  }

  console.log("Application data PostgreSQL se initialize ho gaya.");
}


async function saveDB() {
  await pool.query(
    `INSERT INTO champion_app_state (id, data, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data,
                   updated_at = NOW()`,
    [JSON.stringify(db)]
  );

  // Local backup bhi update rahega.
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function findUser(email) {
  return db.users.find(
    user => user.email.toLowerCase() === email.toLowerCase()
  );
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  
    className: user.className || ""
  };
}


function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please login first." });
  }

  const user = db.users.find(u => u.id === req.session.userId);

  if (!user) {
    return res.status(401).json({ error: "Account not found. Log in again." });
  }

  if (user.role === "student" && user.active === false) {
    return res.status(403).json({
      error: "Your student account is inactive. Please contact Admin."
    });
  }

  req.user = user;
  next();
}


function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission." });
    }
    next();
  };
}


const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Please try again after 1 minute."
  }
});


async function createInitialAccount(role, name, email, password) {
  if (!email || !password) return;

  const normalizedEmail = email.trim().toLowerCase();
  let user = findUser(normalizedEmail);

  if (password.length < 6) {
    throw new Error(role + " password must be at least 6 characters.");
  }

  if (!user) {
    user = {
      id: makeId("user"),
      name,
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role,
      className: ""
    };
    db.users.push(user);
  } else {
    user.name = name;
    user.role = role;
    user.passwordHash = await bcrypt.hash(password, 12);
  }
}

async function initializeAccounts() {
  await createInitialAccount(
    "admin",
    process.env.ADMIN_NAME || "Portal Admin",
    process.env.ADMIN_EMAIL || "admin@example.com",
    process.env.ADMIN_PASSWORD || "ChangeAdmin123!"
  );

  await createInitialAccount(
    "teacher",
    process.env.TEACHER_NAME || "Class Teacher",
    process.env.TEACHER_EMAIL || "teacher@example.com",
    process.env.TEACHER_PASSWORD || "ChangeTeacher123!"
  );

  await createInitialAccount(
    "cashier",
    process.env.CASHIER_NAME || "Fee Cashier",
    process.env.CASHIER_EMAIL || "cashier@example.com",
    process.env.CASHIER_PASSWORD || "ChangeCashier123!"
  );

   await saveDB();
}

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function sendOTP(email, code) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is missing.");
  }

  const from = process.env.RESEND_FROM;

  if (!from) {
    throw new Error("RESEND_FROM is missing.");
  }

  const { data, error } = await resend.emails.send({
    from,
    to: email,
    subject: "CHAMPION CLASSES login OTP",
    text:
      "Your CHAMPION CLASSES login OTP is " +
      code +
      ". It expires in 5 minutes. Do not share it."
  });

  if (error) {
    console.error("Resend email error:", error.message);
    throw new Error("Email provider could not send OTP.");
  }

  if (!data) {
    throw new Error("Email provider returned no confirmation.");
  }
}

// STEP 1: Email + password check, then send a 6-digit OTP.
// DIRECT LOGIN: Email + password, no OTP required.
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || "");
    const role = clean(req.body.role, 20);

    if (!validEmail(email) || !password) {
      return res.status(400).json({
        error: "Valid email aur password required hai."
      });
    }

    if (!["admin", "teacher", "student", "cashier"].includes(role)) {
      return res.status(400).json({
        error: "Valid login type select karo."
      });
    }

    const user = findUser(email);
    const passwordOK = user && user.role === role
      ? await bcrypt.compare(password, user.passwordHash)
      : false;

    if (!passwordOK) {
      return res.status(401).json({
        error: "Email, password ya login type galat hai."
      });
    }
    if (user.role === "student" && user.active === false) {
  return res.status(403).json({
    error: "Your student account is inactive. Please contact Admin."
  });
}

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({
          error: "Login session create nahi hua."
        });
      }

      req.session.userId = user.id;

      req.session.save(saveError => {
        if (saveError) {
          return res.status(500).json({
            error: "Login session save nahi hua."
          });
        }

        return res.json({ user: safeUser(user) });
      });
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      error: "Login mein problem hui. Dobara try karo."
    });
  }
});
app.get("/api/me", requireLogin, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("champion.sid");
    res.json({ ok: true });
  });
});

app.get("/api/dashboard", requireLogin, (req, res) => {
  const role = req.user.role;
  const studentId = req.user.id;

  res.json({
    stats: {
      students: role === "student" ? 1 : db.students.length,
      tests: db.tests.filter(t =>
        t.published &&
        (role !== "student" || t.className === req.user.className)
      ).length,
      results: db.results.filter(r =>
        role !== "student" || r.studentUserId === studentId
      ).length,
      attendanceRecords: db.attendance.filter(a =>
        role !== "student" || a.studentUserId === studentId
      ).length,
      feesDue: db.fees.filter(f =>
        f.status !== "Paid" &&
        (role !== "student" || f.studentUserId === studentId)
      ).length
    }
  });
});

// STUDENTS: Admin creates accounts.
app.get("/api/students", requireLogin, allowRoles("admin", "teacher", "cashier"), (req, res) => {
  res.json({ students: db.students });
});



app.post("/api/students", requireLogin, allowRoles("admin"), async (req, res) => {
  const name = clean(req.body.name);
  const email = clean(req.body.email, 160).toLowerCase();
  const className = clean(req.body.className, 60);
  const password = String(req.body.password || "");

  const monthlyFee = Number(req.body.monthlyFee);
  const totalCourseFee = Number(req.body.totalCourseFee);

  // Validate student details and fees
  if (
    !name ||
    !validEmail(email) ||
    !className ||
    password.length < 6 ||
    req.body.monthlyFee === undefined ||
    req.body.monthlyFee === "" ||
    !Number.isFinite(monthlyFee) ||
    monthlyFee < 0 ||
    req.body.totalCourseFee === undefined ||
    req.body.totalCourseFee === "" ||
    !Number.isFinite(totalCourseFee) ||
    totalCourseFee < 0
  ) {
    return res.status(400).json({
      error: "Student details, valid password, monthly fee aur total course fee required hain."
    });
  }

  // Check duplicate email
  if (findUser(email)) {
    return res.status(409).json({
      error: "Is email ka account already exists."
    });
  }

  // Create user account
  const user = {
    id: makeId("user"),
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "student",
    className
  };

  // Create student record
  const student = {
    id: makeId("student"),
    userId: user.id,
    name,
    email,
    className,
    monthlyFee,
    totalCourseFee,
    studentCode: "CC-" + Date.now().toString().slice(-7),
    createdAt: new Date().toISOString()
  };

db.users.push(user);
db.students.push(student);

saveDB();

res.status(201).json({ student });
});

// UPDATE STUDENT: Admin can edit student details and fees.
app.put("/api/students/:id", requireLogin, allowRoles("admin"), async (req, res) => {
  const student = db.students.find(s => s.id === req.params.id);

  if (!student) {
    return res.status(404).json({
      error: "Student nahi mila."
    });
  }

  const name = clean(req.body.name);
  const email = clean(req.body.email, 160).toLowerCase();
  const className = clean(req.body.className, 60);
  const studentCode = clean(req.body.studentCode, 40);

  const monthlyFee = Number(req.body.monthlyFee);
  const totalCourseFee = Number(req.body.totalCourseFee);

  if (
    !name ||
    !validEmail(email) ||
    !className ||
    !studentCode ||
    req.body.monthlyFee === undefined ||
    req.body.monthlyFee === "" ||
    !Number.isFinite(monthlyFee) ||
    monthlyFee < 0 ||
    req.body.totalCourseFee === undefined ||
    req.body.totalCourseFee === "" ||
    !Number.isFinite(totalCourseFee) ||
    totalCourseFee < 0
  ) {
    return res.status(400).json({
      error: "Student details aur valid fees required hain."
    });
  }

  const duplicateEmail = db.users.find(
    u => u.email === email && u.id !== student.userId
  );

  if (duplicateEmail) {
    return res.status(409).json({
      error: "Ye email kisi aur account mein use ho raha hai."
    });
  }

  const duplicateCode = db.students.find(
    s => s.studentCode === studentCode && s.id !== student.id
  );

  if (duplicateCode) {
    return res.status(409).json({
      error: "Ye Student ID pehle se kisi aur student ki hai."
    });
  }

  const user = db.users.find(u => u.id === student.userId);

  if (!user) {
    return res.status(404).json({
      error: "Student ka login account nahi mila."
    });
  }

  student.name = name;
  student.email = email;
  student.className = className;
  student.studentCode = studentCode;
  student.monthlyFee = monthlyFee;
  student.totalCourseFee = totalCourseFee;

  user.name = name;
  user.email = email;
  user.className = className;

  saveDB();

  res.json({
    ok: true,
    student
  });
});


// ACTIVATE / DEACTIVATE STUDENT: Admin only.
app.patch("/api/students/:id/status", requireLogin, allowRoles("admin"), async (req, res) => {
  const student = db.students.find(s => s.id === req.params.id);

  if (!student) {
    return res.status(404).json({
      error: "Student nahi mila."
    });
  }

  const user = db.users.find(u => u.id === student.userId);

  if (!user) {
    return res.status(404).json({
      error: "Student ka login account nahi mila."
    });
  }

  const active = req.body.active;

  if (typeof active !== "boolean") {
    return res.status(400).json({
      error: "Valid status required hai."
    });
  }

  student.active = active;
  user.active = active;

  await saveDB();

  res.json({
    ok: true,
    message: active ? "Student account activated." : "Student account deactivated.",
    student
  });
});

app.get("/api/attendance", requireLogin, (req, res) => {
  const date = clean(req.query.date, 10);

  const rows = db.attendance.filter(a =>
    (!date || a.date === date) &&
    (req.user.role !== "student" || a.studentUserId === req.user.id)
  );

  res.json({ attendance: rows });
});

app.post("/api/attendance/bulk", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const date = clean(req.body.date, 10);
  const records = Array.isArray(req.body.records) ? req.body.records : [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !records.length) {
    return res.status(400).json({ error: "Date aur attendance records required." });
  }

  for (const record of records) {
    const student = db.students.find(s => s.id === record.studentId);

    if (!student || !["Present", "Absent", "Late"].includes(record.status)) continue;

    const old = db.attendance.find(a =>
      a.studentId === student.id && a.date === date
    );

    const entry = {
      id: old ? old.id : makeId("att"),
      studentId: student.id,
      studentUserId: student.userId,
      name: student.name,
      className: student.className,
      date,
      status: record.status,
      markedBy: req.user.id
    };

    if (old) Object.assign(old, entry);
    else db.attendance.push(entry);
  }

  saveDB();
  res.json({ ok: true, message: "Attendance save ho gayi." });
});

app.get("/api/attendance/overview", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const overview = db.students.map(student => {
    const records = db.attendance.filter(a => a.studentId === student.id);
    const present = records.filter(a => a.status === "Present").length;
    const absent = records.filter(a => a.status === "Absent").length;

    return {
      studentId: student.id,
      name: student.name,
      studentCode: student.studentCode,
      className: student.className,
      presentDays: present,
      absentDays: absent,
      totalDays: records.length,
      percentage: records.length ? Math.round(present / records.length * 100) : 0
    };
  });

  res.json({ overview });
});

// TESTS: teacher submits, student takes, teacher/admin publishes results.

app.get("/api/tests", requireLogin, (req, res) => {
  const tests = db.tests
    .filter(test =>
      req.user.role !== "student" ||
      (test.published &&
       test.className === req.user.className)
    )
    .map(test => {
      if (req.user.role === "student") {
        return {
          ...test,
          questions: test.questions.map(
            ({ answer, solution, ...question }) => question
          )
        };
      }

      // Admin aur teacher ko Answer Key aur solutions milenge
      return test;
    });

  res.json({ tests });
});

app.post("/api/tests", requireLogin, allowRoles("admin", "teacher"), async (req, res) => {
  try {
    const title = clean(req.body.title);
    const className = clean(req.body.className, 60);
    const questions = req.body.questions;

    if (!title || !className || !Array.isArray(questions) || !questions.length) {
      return res.status(400).json({
        error: "Title, class aur JSON questions required."
      });
    }

    if (questions.length > 100) {
      return res.status(400).json({
        error: "Ek test mein maximum 100 questions."
      });
    }

    for (const q of questions) {
      if (
        !clean(q.text, 500) ||
        !Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.length > 10 ||
        !q.options.includes(q.answer)
      ) {
        return res.status(400).json({
          error: "Har question mein text, 2-10 options aur matching answer required."
        });
      }
    }

    const test = {
      id: makeId("test"),
      title,
      className,
      questions: questions.map(q => ({
  id: makeId("q"),
  text: clean(q.text, 500),
  options: q.options.map(option => clean(option, 250)),
  answer: clean(q.answer, 250),
  solution: clean(q.solution || "", 3000)
})),
      published: false,
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
      publishedAt: null
    };

    db.tests.push(test);
    await saveDB();

    res.status(201).json({
      test: {
        ...test,
        questions: test.questions.map(({ answer, ...q }) => q)
      }
    });
  } catch (error) {
    console.error("Create test error:", error);
    res.status(500).json({ error: "Test save nahi ho saka." });
  }
});

app.delete("/api/tests/:id", requireLogin, allowRoles("admin"), async (req, res) => {
  try {
    const testId = req.params.id;
    const test = db.tests.find(t => t.id === testId);

    if (!test) {
      return res.status(404).json({ error: "Test nahi mila." });
    }

    db.submissions = db.submissions.filter(
      s => s.testId !== testId
    );

    db.results = db.results.filter(
      r => r.testId !== testId
    );

    db.tests = db.tests.filter(
      t => t.id !== testId
    );

    await saveDB();

    res.json({
      ok: true,
      message: "Test aur uske related results delete ho gaye."
    });
  } catch (error) {
    console.error("Delete test error:", error);
    res.status(500).json({ error: "Test delete nahi ho saka." });
  }
});

app.post("/api/tests/:id/publish", requireLogin, allowRoles("admin", "teacher"), async (req, res) => {
  try {
    const test = db.tests.find(t => t.id === req.params.id);

    if (!test) {
      return res.status(404).json({ error: "Test nahi mila." });
    }

    test.published = true;
    test.publishedAt = new Date().toISOString();

    await saveDB();

    res.json({
      ok: true,
      message: test.title + " " + test.className + " ke liye publish ho gaya."
    });
  } catch (error) {
    console.error("Publish test error:", error);
    res.status(500).json({ error: "Test publish nahi ho saka." });
  }
});


app.post("/api/tests/:id/submit", requireLogin, allowRoles("student"), async (req, res) => {
  try {
    const test = db.tests.find(t =>
      t.id === req.params.id &&
      t.published &&
      t.className === req.user.className
    );

    if (!test) {
      return res.status(404).json({
        error: "Test available nahi hai."
      });
    }

    if (db.submissions.some(s =>
      s.testId === test.id && s.studentUserId === req.user.id
    )) {
      return res.status(409).json({
        error: "Aap ye test pehle submit kar chuke hain."
      });
    }

    const answers =
      req.body.answers && typeof req.body.answers === "object"
        ? req.body.answers
        : {};

    let score = 0;

    for (const question of test.questions) {
      if (answers[question.id] === question.answer) {
        score++;
      }
    }

    db.submissions.push({
      id: makeId("submission"),
      testId: test.id,
      testTitle: test.title,
      studentUserId: req.user.id,
      studentName: req.user.name,
      className: test.className,
      score,
      total: test.questions.length,
      answers: Object.fromEntries(
        test.questions.map(q => [
          q.id,
          typeof answers[q.id] === "string"
            ? answers[q.id]
            : ""
        ])
      ),
      submittedAt: new Date().toISOString(),
      published: false
    });

    await saveDB();

    res.json({
      message: "Test submit ho gaya. Teacher result publish karega tabhi marks dikhenge."
    });
  } catch (error) {
    console.error("Submit test error:", error);
    res.status(500).json({
      error: "Test submit nahi ho saka."
    });
  }
});


// RESULTS: student can only see published results.

app.get("/api/results", requireLogin, (req, res) => {
  const results = db.results
    .filter(r =>
      req.user.role !== "student" ||
      (r.studentUserId === req.user.id && r.published === true)
    )
    .map(result => {
      if (req.user.role !== "student") {
        return result;
      }

      const submission = db.submissions.find(s =>
        s.id === result.submissionId &&
        s.studentUserId === req.user.id &&
        s.published === true
      );

      const test = db.tests.find(t =>
        t.id === result.testId
      );

      if (!submission || !test) {
        return result;
      }

      return {
        ...result,
        review: test.questions.map(q => ({
          id: q.id,
          text: q.text,
          options: q.options,
          selectedAnswer: submission.answers?.[q.id] || "",
          correctAnswer: q.answer,
          solution: q.solution || ""
        }))
      };
    });

  res.json({ results });
});


app.get("/api/results/overview", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const overview = db.submissions.map(s => ({
    id: s.id,
    testId: s.testId,
    testTitle: s.testTitle,
    studentName: s.studentName,
    studentUserId: s.studentUserId,
    className: s.className,
    score: s.score,
    total: s.total,
    submittedAt: s.submittedAt,
    published: s.published
  }));

  res.json({ overview });
});


app.post("/api/results/publish", requireLogin, allowRoles("admin", "teacher"), async (req, res) => {
  try {
    const testId = clean(req.body.testId, 100);
    const className = clean(req.body.className, 60);

    let count = 0;

    for (const submission of db.submissions) {
      if (testId && submission.testId !== testId) continue;
      if (className && submission.className !== className) continue;

      // Already-published results ko dobara count nahi karna.
      const alreadyPublished = db.results.some(
        r => r.submissionId === submission.id
      );

      if (alreadyPublished) continue;

      submission.published = true;

      const result = {
        id: makeId("result"),
        submissionId: submission.id,
        testId: submission.testId,
        testTitle: submission.testTitle,
        studentUserId: submission.studentUserId,
        studentName: submission.studentName,
        className: submission.className,
        score: submission.score,
        total: submission.total,
        percentage: submission.total
          ? Math.round(submission.score / submission.total * 100)
          : 0,
        published: true,
        publishedAt: new Date().toISOString()
      };

      db.results.push(result);
      count++;
    }

    await saveDB();

    res.json({
      ok: true,
      message: count + " result(s) publish ho gaye."
    });
  } catch (error) {
    console.error("Publish results error:", error);
    res.status(500).json({ error: "Results publish nahi ho sake." });
  }
});

// STUDENT: Create Razorpay payment order.
app.post("/api/payments/create-order", requireLogin, allowRoles("student"), async (req, res) => {
  try {
    const student = db.students.find(s => s.userId === req.user.id);
    const amount = Number(req.body.amount);
    const amountPaise = Math.round(amount * 100);
    const month = clean(req.body.month, 60) || "Fee payment";

    if (!student) {
      return res.status(404).json({ error: "Student record nahi mila." });
    }

    if (!Number.isFinite(amount) || amount <= 0 ||
        !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: "Valid payment amount required." });
    }

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: "SP-" + Date.now(),
      notes: {
        studentUserId: req.user.id,
        studentId: student.id,
        month
      }
    });

    db.paymentOrders.push({
      orderId: order.id,
      studentUserId: req.user.id,
      studentId: student.id,
      amount: amount,
      month,
      status: "created",
      createdAt: new Date().toISOString()
    });

    await saveDB();

    res.status(201).json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      studentName: student.name,
      studentEmail: student.email
    });
  } catch (error) {
    console.error("Payment order error:", error);
    res.status(500).json({ error: "Payment order create nahi ho saka." });
  }
});


// STUDENT: Verify payment and save fee receipt.
app.post("/api/payments/verify", requireLogin, allowRoles("student"), async (req, res) => {
  try {
    const orderId = clean(req.body.razorpay_order_id, 100);
    const paymentId = clean(req.body.razorpay_payment_id, 100);
    const signature = clean(req.body.razorpay_signature, 200);

    const orderRecord = db.paymentOrders.find(o =>
      o.orderId === orderId &&
      o.studentUserId === req.user.id
    );

    if (!orderRecord || !paymentId || !signature) {
      return res.status(400).json({ error: "Invalid payment details." });
    }

    if (orderRecord.status === "paid") {
      const existingFee = db.fees.find(f => f.orderId === orderId);
      return res.json({ ok: true, fee: existingFee });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const receivedBuffer = Buffer.from(signature, "hex");

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return res.status(400).json({ error: "Payment signature invalid." });
    }

    const payment = await razorpay.payments.fetch(paymentId);

    if (
      payment.order_id !== orderId ||
      payment.status !== "captured" ||
      payment.amount !== Math.round(orderRecord.amount * 100) ||
      payment.currency !== "INR"
    ) {
      return res.status(400).json({ error: "Payment captured verify nahi hua." });
    }

    const student = db.students.find(s => s.id === orderRecord.studentId);

    if (!student || student.userId !== req.user.id) {
      return res.status(400).json({ error: "Student record invalid." });
    }

    const fee = {
      id: makeId("fee"),
      receiptNo: "SP-R-" + Date.now(),
      studentId: student.id,
      studentUserId: student.userId,
      studentName: student.name,
      className: student.className,
      amount: orderRecord.amount,
      month: orderRecord.month,
      status: "Paid",
      collectedBy: "razorpay",
      paymentId,
      orderId,
      paymentMethod: payment.method || "online",
      createdAt: new Date().toISOString()
    };

    db.fees.push(fee);
    orderRecord.status = "paid";
    orderRecord.paymentId = paymentId;
    orderRecord.paidAt = new Date().toISOString();

    await saveDB();

    res.json({ ok: true, fee });
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ error: "Payment verify nahi ho saka." });
  }
});
// STUDENT: Get own fee information.
app.get("/api/payments/info", requireLogin, allowRoles("student"), (req, res) => {
  const student = db.students.find(s => s.userId === req.user.id);

  if (!student) {
    return res.status(404).json({
      error: "Student record nahi mila."
    });
  }

  res.json({
    studentName: student.name,
    studentCode: student.studentCode,
    className: student.className,
    monthlyFee: Number(student.monthlyFee || 0)
  });
});

// CASHIER: payment entry and receipts.
app.get("/api/fees", requireLogin, allowRoles("admin", "cashier", "student"), (req, res) => {
  const fees = db.fees.filter(f =>
    req.user.role !== "student" || f.studentUserId === req.user.id
  );
  res.json({ fees });
});

app.post("/api/fees", requireLogin, allowRoles("admin", "cashier"), async (req, res) => {
  try {
    const student = db.students.find(s => s.id === req.body.studentId);
    const amount = Number(req.body.amount);

    if (!student || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Student aur valid amount required."
      });
    }

    const fee = {
      id: makeId("fee"),
      receiptNo: "CC-R-" + Date.now(),
      studentId: student.id,
      studentUserId: student.userId,
      studentName: student.name,
      className: student.className,
      amount,
      month: clean(req.body.month, 60),
      status: "Paid",
      collectedBy: req.user.id,
      createdAt: new Date().toISOString()
    };

    db.fees.push(fee);
    await saveDB();

    res.status(201).json({ fee });
  } catch (error) {
    console.error("Fee save error:", error);
    res.status(500).json({ error: "Fee save nahi ho saki." });
  }
});

// NOTICES
app.get("/api/notices", requireLogin, (req, res) => {
  res.json({
    notices: db.notices.filter(n =>
      n.className === "All" ||
      n.className === req.user.className ||
      ["admin", "teacher"].includes(req.user.role)
    )
  });
});


app.post("/api/notices", requireLogin, allowRoles("admin", "teacher"), async (req, res) => {
  try {
    const title = clean(req.body.title);
    const body = clean(req.body.body, 2000);
    const className = clean(req.body.className, 60) || "All";

    if (!title || !body) {
      return res.status(400).json({
        error: "Notice title aur message required."
      });
    }

    const notice = {
      id: makeId("notice"),
      title,
      body,
      className,
      createdAt: new Date().toISOString(),
      createdBy: req.user.id
    };

    db.notices.unshift(notice);
    await saveDB();

    res.status(201).json({ notice });
  } catch (error) {
    console.error("Notice save error:", error);
    res.status(500).json({
      error: "Notice save nahi ho saka."
    });
  }
});


// Keep this 404 handler AFTER all API routes.

/* ============== SIGMA POINT NOTES API ============== */

// Notes list: students ko sirf apni class ke notes dikhenge
app.get("/api/notes", requireLogin, (req, res) => {
  if (!["admin", "teacher", "student"].includes(req.user.role)) {
    return res.status(403).json({ error: "Access denied." });
  }

  const notes = Array.isArray(db.notes) ? db.notes : [];

  const visibleNotes = ["admin", "teacher"].includes(req.user.role)
    ? notes
    : notes.filter(note => note.className === req.user.className);

  res.json({ notes: visibleNotes });
});


// Admin only: PDF/JPG notes upload
app.post(
  "/api/notes",
  requireLogin,
  allowRoles("admin"),
  handleNoteUpload,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "PDF ya JPG file select karein."
        });
      }

      const title = clean(req.body.title, 120);
      const subject = clean(req.body.subject, 80);
      const className = clean(req.body.className, 60);

      if (!title || !subject || !className) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({
          error: "Title, subject aur class required hain."
        });
      }

      if (!Array.isArray(db.notes)) {
        db.notes = [];
      }

      const note = {
        id: makeId("note"),
        title,
        subject,
        className,
        filename: req.file.filename,
        originalName: path.basename(req.file.originalname),
        mimeType: req.file.mimetype,
        size: req.file.size,
        createdAt: new Date().toISOString(),
        createdBy: req.user.id
      };

      db.notes.unshift(note);

      try {
        await saveDB();
      } catch (error) {
        db.notes = db.notes.filter(item => item.id !== note.id);
        await fs.promises.unlink(req.file.path).catch(() => {});
        throw error;
      }

      return res.status(201).json({
        message: "Notes upload ho gaye.",
        note
      });
    } catch (error) {
      console.error("Notes upload error:", error);
      return res.status(500).json({
        error: "Notes save nahi ho sake."
      });
    }
  }
);


// Notes file open karna
app.get("/api/notes/:id/file", requireLogin, (req, res) => {
  const notes = Array.isArray(db.notes) ? db.notes : [];
  const note = notes.find(item => item.id === req.params.id);

  if (!note) {
    return res.status(404).json({ error: "Notes nahi mile." });
  }

  const isStaff = ["admin", "teacher"].includes(req.user.role);
  const isSameClass = note.className === req.user.className;

  if (!isStaff && !isSameClass) {
    return res.status(403).json({
      error: "Is class ke notes ka access nahi hai."
    });
  }

  const filePath = path.join(
    NOTES_DIR,
    path.basename(note.filename)
  );

  res.sendFile(
    filePath,
    {
      headers: {
        "Content-Type": note.mimeType,
        "Content-Disposition":
          `inline; filename="${path.basename(note.originalName)}"`
      }
    },
    error => {
      if (error && !res.headersSent) {
        res.status(error.statusCode || 404).json({
          error: "Notes file nahi mil rahi."
        });
      }
    }
  );
});


// Admin only: notes delete
app.delete(
  "/api/notes/:id",
  requireLogin,
  allowRoles("admin"),
  async (req, res) => {
    const notes = Array.isArray(db.notes) ? db.notes : [];
    const index = notes.findIndex(
      item => item.id === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({ error: "Notes nahi mile." });
    }

    const note = notes[index];

    try {
      notes.splice(index, 1);

      try {
        await saveDB();
      } catch (error) {
        notes.splice(index, 0, note);
        throw error;
      }

      const filePath = path.join(
        NOTES_DIR,
        path.basename(note.filename)
      );

      await fs.promises.unlink(filePath).catch(error => {
        if (error.code !== "ENOENT") {
          console.error("Notes file delete error:", error);
        }
      });

      return res.json({ message: "Notes delete ho gaye." });
    } catch (error) {
      console.error("Notes delete error:", error);
      return res.status(500).json({
        error: "Notes delete nahi ho sake."
      });
    }
  }
);

/* ============== END NOTES API ============== */

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


async function startServer() {
  try {
    // Step 1: PostgreSQL se application data load karo
    await loadDB();

    // Step 2: Accounts initialize karo aur PostgreSQL mein save karo
    await initializeAccounts();
    await saveDB();

    // Step 3: Sab ready hone ke baad server start karo
    app.listen(PORT, () => {
      console.log(
        "CHAMPION CLASSES running at http://localhost:" + PORT
      );
      console.log("PostgreSQL data loaded successfully.");
      console.log(
        "Admin email: " +
        (process.env.ADMIN_EMAIL || "admin@example.com")
      );
      console.log(
        "Teacher email: " +
        (process.env.TEACHER_EMAIL || "teacher@example.com")
      );
    });
  } catch (error) {
    console.error("Startup error:", error.message);
    process.exit(1);
  }
}

startServer();
