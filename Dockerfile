# Use Node.js 20
FROM node:20

# Set working directory
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install

# Copy remaining files
COPY . .

# Expose the port your app uses
EXPOSE 3000

# Start the app
CMD ["node", "app.js"]

