"use strict";
const cloudinary = require("cloudinary").v2;

require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
  } else {
    console.log("Connected to MySQL");
  }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Запуск сервера
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is on port ${PORT}`);
});

const users = new Map();

const io = require("socket.io")(3000, {
  cors: {
    origin: ["http://localhost:8081"],
  },
});
io.on("connection", (socket) => {
  console.log("new socket: ", socket.id);

  socket.on("register", (userID) => {
    users.set(userID, socket.id);
    console.log(`User ${userID} registered to this socket id: ${socket.id}`);
  });

  socket.on("send-message", ({ receiverID, message }) => {
    console.log("send-message event here!", receiverID, message);
    const receiverSocketID = users.get(receiverID);
    console.log(receiverSocketID, " is the receiver's socket id");
    if (receiverSocketID) {
      io.to(receiverSocketID).emit("receive-message", message);
      console.log(`user ${receiverID} is receiving a message}`, message);
    }
  });

  socket.on("disconnect", (socket) => {
    for (let [userID, socketID] of users.entries()) {
      if (socket.id === socketID) {
        users.delete(userID);
        console.log(`User ${userID} disconnected (${socketID})`);
        break;
      }
    }
  });
});

app.post("/login", (req, res) => {
  const { login, password } = req.body;
  const sql =
    "SELECT * FROM users WHERE (email = ? OR userName = ?) AND password = ?";
  db.query(sql, [login, login, password], (err, result) => {
    if (err) return res.status(500).json({ error: err });
    if (result.length > 0) {
      res.json({ success: true, user: result[0] });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  });
});

app.post("/changeUserData", (req, res) => {
  const { userID, newFirstName, newLastName, newUserName } = req.body;
  const sql =
    "UPDATE users SET firstName = ?, lastName = ?, userName = ? WHERE userID = ?";
  db.query(
    sql,
    [newFirstName, newLastName, newUserName, userID],
    (err, result) => {
      if (err) return res.status(500).json({ error: err });
      if (result.affectedRows > 0) {
        res.json({ success: true });
      } else {
        res
          .status(400)
          .json({ success: false, message: "Bad request / No changes made" });
      }
    }
  );
});

const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload-avatar", upload.single("avatar"), async (req, res) => {
  try {
    //finding the old profile picture
    db.query(
      "SELECT avatarUrl FROM users WHERE userID = ?",
      [req.body.userID],
      async (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        const oldAvatarUrl = result[0]?.avatarUrl;

        //deleting it
        if (oldAvatarUrl) {
          const publicId = oldAvatarUrl.split("/").pop().split(".")[0]; // Отримуємо public_id файлу
          await cloudinary.uploader.destroy(`${publicId}`);
        }

        //uploading the new profile picture and setting its url in the database
        const uploadResult = cloudinary.uploader.upload_stream(
          async (error, uploadedFile) => {
            if (error) return res.status(500).json({ error });
            db.query("UPDATE users SET avatarUrl = ? WHERE userID = ?", [
              uploadedFile.secure_url,
              req.body.userID,
            ]);

            res.json({ secure_url: uploadedFile.secure_url });
          }
        );

        uploadResult.end(req.file.buffer);
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const randomNumber = (min, max) => {
  return Math.floor(Math.random() * (max - min)) + min;
};
const generateCode = () => {
  let result = "";
  for (let i = 0; i < 6; i++) result += randomNumber(0, 9);
  return result;
};

// Налаштування SMTP Gmail
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});
// console.log(process.env.GMAIL_PASS, process.env.GMAIL_USER);

app.post("/send-code", async (req, res) => {
  const { userEmail } = req.body;
  console.log(userEmail);
  const verificationCode = generateCode();

  const sql = "INSERT INTO signup_codes (signup_email, code) VALUES (?, ?)";
  db.query(sql, [userEmail, verificationCode], (err, result) => {
    if (err) return res.status(500).json({ error: err });
    if (result.affectedRows > 0) {
      // res.json({ success: true });
      console.log(`on db: ${userEmail} - ${verificationCode}`);
    } else {
      res
        .status(400)
        .json({ success: false, message: "Bad request / No changes made" });
      return;
    }
  });

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: userEmail,
    subject: "Your Encrypto registration verification code",
    text: `Your code is ${verificationCode}`,
  };
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(info.messageId);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: "Error sending the email." });
  }
});

app.post("/verify-code", async (req, res) => {
  const { code, enteredEmail } = req.body;

  const sql =
    "SELECT COUNT(*) AS match_count FROM signup_codes WHERE signup_email = ? AND code = ?";
  db.query(sql, [enteredEmail, code], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result[0].match_count > 0) {
      res.json({ success: true, message: "Code is valid" });
      db.query(
        "DELETE FROM signup_codes WHERE signup_email = ?",
        [enteredEmail]
        // (err, result) => console.log("deleting results: ", err, result)
      );
    } else {
      res.status(400).json({ success: false, message: "Wrong code" });
    }
  });
});

app.post("/signup-data", async (req, res) => {
  const { email, firstName, lastName, userName, password } = req.body;

  // 1. Перевірка наявності email
  const sqlCheckEmail = "SELECT email FROM users WHERE email = ?";
  db.query(sqlCheckEmail, [email], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      return res.status(400).json({
        success: false,
        message: "There is already an account with this email address.",
      });
    }

    // 2. Перевірка унікальності userName
    const sqlCheckUserName = "SELECT userName FROM users WHERE userName = ?";
    db.query(sqlCheckUserName, [userName], (err, result) => {
      if (err) return res.status(500).json({ error: err });

      if (result.length > 0) {
        return res.status(400).json({
          success: false,
          message: "This username is occupied.",
        });
      }

      // 3. Якщо email та userName унікальні — додаємо нового користувача
      const sqlAddUser =
        "INSERT INTO users (firstName, lastname, userName, email, password) VALUES (?,?,?,?,?)";
      db.query(
        sqlAddUser,
        [firstName, lastName, userName, email, password],
        (err, result) => {
          if (err) return res.status(500).json({ error: err });

          if (result.affectedRows > 0) {
            res.json({
              success: true,
              message: "New user added",
              insertId: result.insertId,
            });
          }
        }
      );
    });
  });
});

app.post("/send-code-forgot", async (req, res) => {
  const { email } = req.body;
  const verificationCode = generateCode();

  const sqlCheckEmail = "SELECT * FROM users WHERE email = ?";
  db.query(sqlCheckEmail, [email], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No user with this email" });
    }

    console.log("Found the user who forgot their password");

    // Тільки якщо користувач знайдений - додаємо код у forgot_codes
    const sql = "INSERT INTO forgot_codes (forgot_email, code) VALUES (?, ?)";
    db.query(sql, [email, verificationCode], async (err, result) => {
      if (err) return res.status(500).json({ error: err });

      if (result.affectedRows === 0) {
        return res
          .status(400)
          .json({ success: false, message: "Bad request / No changes made" });
      }

      console.log(`on db(forgot): ${email} - ${verificationCode}`);

      // Після успішного додавання коду - надсилаємо email
      const mailOptions = {
        from: process.env.GMAIL_USER,
        to: email,
        subject:
          "Your Encrypto verification code for resetting the forgotten password",
        text: `Your code is ${verificationCode}`,
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log(info.messageId);
        res.json({ success: true });
      } catch (error) {
        res.json({
          success: false,
          message: "Error sending the email (send-code-forgot).",
        });
      }
    });
  });
});

app.post("/verify-code-forgot", async (req, res) => {
  const { code, enteredEmail } = req.body;

  const sql =
    "SELECT COUNT(*) AS match_count FROM forgot_codes WHERE forgot_email = ? AND code = ?";
  db.query(sql, [enteredEmail, code], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result[0].match_count > 0) {
      res.json({ success: true, message: "Code is valid" });
      db.query(
        "DELETE FROM forgot_codes WHERE forgot_email = ?",
        [enteredEmail]
        // (err, result) => console.log("deleting results: ", err, result)
      );
    } else {
      res.status(400).json({ success: false, message: "Wrong code" });
    }
  });
});

app.post("/change-password", async (req, res) => {
  const { email, newPassword } = req.body;

  const sql = "UPDATE users SET password = ? WHERE email = ?";
  db.query(sql, [newPassword, email], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.affectedRows > 0)
      res.json({ success: true, message: "Password changed successfully" });
    else
      res.status(400).json({
        success: false,
        message: "The user doesn't exist on the database???",
      });
  });
});

//-- SELECT chatID FROM chats WHERE FIND_IN_SET('1', participantsIDs); --works

app.post("/get-chats", async (req, res) => {
  const { userID } = req.body;
  if (!userID) {
    console.log("didn't get the user's ID?");
    return res.status(500).json({ error: "didn't get the user's ID" });
  }
  const sql = "SELECT * FROM chats WHERE FIND_IN_SET('?', participantsIDs)";
  db.query(sql, [userID], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      // console.log(result);
      res.json({ success: true, chats: result });
    } else res.status(400).json({ success: false, message: "db error?" });
  });
});

app.post("/get-user", async (req, res) => {
  const { userID } = req.body;
  const sql = "SELECT * FROM users WHERE userID = ?";
  db.query(sql, [userID], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      res.json({ success: true, user: result[0] });
    } else
      res
        .status(400)
        .json({ success: false, message: "db error in get-user?" });
  });
});

app.post("/get-messages", async (req, res) => {
  const { chatID } = req.body;
  const sql = "SELECT * FROM messages WHERE chatID = ?";

  db.query(sql, [chatID], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      res.json({ success: true, messages: result });
    } else
      res
        .status(400)
        .json({ success: false, message: "db error? get-messages" });
  });
});

app.post("/send-message", async (req, res) => {
  const { messageData } = req.body;
  const sql = "INSERT INTO messages (chatID, senderID, message) VALUES(?,?,?)";
  db.query(
    sql,
    [messageData.chatID, messageData.senderID, messageData.message],
    (err, result) => {
      if (err) return res.status(500).json({ error: err });

      if (result.affectedRows > 0) {
        res.json({ success: true, messageID: result.insertId });
      } else
        res
          .status(400)
          .json({ success: false, message: "didnt add the message to the db" });
    }
  );
});
app.post("/get-last-message", async (req, res) => {
  const { chatID, participantsIDs } = req.body;
  const sql =
    "SELECT * FROM messages WHERE chatID = ? ORDER BY messageID DESC LIMIT 1";
  db.query(sql, [chatID], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      // console.log(result[0]);
      res.json({ success: true, lastMessage: result[0] });
    } else
      res
        .status(400)
        .json({ success: false, message: "didnt find the last message" });
  });
});

app.post("/fetch-users", async (req, res) => {
  const { searchString } = req.body;
  const sql =
    "SELECT * FROM users WHERE userName LIKE ? OR CONCAT(firstName, lastName) LIKE ?";
  const likeSearch = `${searchString}%`;
  db.query(sql, [likeSearch, likeSearch], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      res.json({ success: true, users: result });
    } else res.json({ success: true, users: null });
  });
});

app.post("/find-chat", async (req, res) => {
  const { user1ID, user2ID } = req.body;
  const sql = "SELECT * FROM chats WHERE participantsIDs = ?";

  const participantsIDs = [
    user1ID < user2ID ? user1ID : user2ID,
    user1ID < user2ID ? user2ID : user1ID,
  ];
  db.query(sql, [participantsIDs.join(",")], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      console.log("found chat!");
      res.json({ success: true, chatID: result[0].chatID });
    } else res.json({ success: false, message: "no chat found" });
  });
});
app.post("/find-chat", async (req, res) => {
  const { user1ID, user2ID } = req.body;
  const sql = "SELECT * FROM chats WHERE participantsIDs = ?";

  const participantsIDs = [
    user1ID < user2ID ? user1ID : user2ID,
    user1ID < user2ID ? user2ID : user1ID,
  ];
  db.query(sql, [participantsIDs.join(",")], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      console.log(`found the chat for ${user1ID} ${user2ID}`);
      res.json({ success: true, chatID: result[0].chatID });
    } else res.json({ success: false, message: "no chat found" });
  });
});

app.post("/create-chat", async (req, res) => {
  const { user1ID, user2ID } = req.body;
  const sql = "INSERT INTO chats (participantsIDs) VALUES (?)";

  const participantsIDs = [
    user1ID < user2ID ? user1ID : user2ID,
    user1ID < user2ID ? user2ID : user1ID,
  ];

  db.query(sql, [participantsIDs.join(",")], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.affectedRows > 0) {
      console.log(`created a new chat for ${user1ID} and ${user2ID}`);

      if (users.get(user2ID)) {
        io.to(users.get(user2ID)).emit("new-chat", {
          chatID: result.insertId,
          participantsIDs: participantsIDs.join(","),
        });
      }

      res.json({ success: true, chatID: result.insertId });
    } else res.json({ success: false, message: "didn't create a chat" });
  });
});
