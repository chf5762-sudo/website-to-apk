SOURCE_FILE="/c/Users/Alex/.gemini/antigravity/brain/b2fd3697-4ee4-4452-afdc-f4f7dfb96133/.system_generated/steps/496/content.md"
TARGET_FILE="app/src/main/assets/www/scripts/mqtt.min.js"
sed -n '/(function/,$p' "$SOURCE_FILE" > "$TARGET_FILE"
head -c 50 "$TARGET_FILE"
