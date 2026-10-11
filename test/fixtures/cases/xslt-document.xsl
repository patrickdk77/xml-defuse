<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:template match="/"><xsl:copy-of select="document('file:///etc/passwd')"/><out a="{unparsed-text('/etc/hosts')}"/><xsl:value-of select="concat('document(', 'x')"/></xsl:template>
</xsl:stylesheet>
