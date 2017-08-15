CREATE DATABASE IF NOT EXISTS concurrence_todo;
CREATE TABLE IF NOT EXISTS concurrence_todo.items(
    id INT NOT NULL AUTO_INCREMENT,
    text TEXT NOT NULL,
    PRIMARY KEY (id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
