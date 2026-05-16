sed -i 's/var room = (new RegExp/var room = (new RegExp("[?\&]room=([^&]+)").exec(location.search) || [])[1] || "123"; \/\/ ?????? 123/g' app/src/main/assets/www/index_v3s.html
sed -i '/log(.ACTION., .Type: ./i if(!url) return;' app/src/main/assets/www/index_v3s.html
